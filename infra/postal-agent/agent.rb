# frozen_string_literal: true

# Mailkong provisioning agent.
#
# WHY THIS EXISTS
#
# Postal's official HTTP API covers sending and message queries only
# (/api/v1/send/*, /api/v1/messages/*), authenticated per mail server with
# X-Server-API-Key. Creating organizations, servers, domains, credentials,
# routes and IP pools is not exposed over HTTP at all -- Postal expects those
# to be done through its web UI.
#
# The control plane needs them programmatically (see spec section 11). The two
# alternatives were:
#
#   1. Write to Postal's MariaDB directly. Rejected: it bypasses ActiveRecord
#      callbacks -- including DKIM keypair generation and permalink
#      uniqueness -- and breaks on any Postal schema change.
#
#   2. Drive `postal console` over SSH per call. Rejected: a Rails boot per
#      request, and shell quoting as a security boundary.
#
# So this loads Postal's own Rails environment once and calls the same models
# its UI does. It binds to loopback only; the control plane reaches it through
# the reverse proxy on Box B under /_agent, which is firewalled to Box A.
#
# RUN IT
#   See infra/postal-agent/README.md. It runs as a systemd unit alongside
#   Postal, not inside the Postal container.

require 'sinatra/base'
require 'json'
require 'openssl'

ENV['RAILS_ENV'] ||= 'production'
require File.expand_path('config/environment', ENV.fetch('POSTAL_ROOT', '/opt/postal/app'))

class MailkongAgent < Sinatra::Base
  set :bind, '127.0.0.1'
  set :port, ENV.fetch('AGENT_PORT', 5000).to_i
  set :show_exceptions, false
  set :raise_errors, false

  AGENT_TOKEN = ENV.fetch('AGENT_TOKEN')
  raise 'AGENT_TOKEN must be at least 32 characters' if AGENT_TOKEN.length < 32

  before do
    content_type :json
    next if request.path_info == '/health'

    presented = request.env['HTTP_AUTHORIZATION'].to_s.sub(/\ABearer\s+/i, '')
    # Constant time so the token cannot be recovered by measuring responses.
    unless OpenSSL.secure_compare(presented, AGENT_TOKEN)
      halt 401, { error: 'unauthorized' }.to_json
    end

    request.body.rewind
    raw = request.body.read
    @body = raw.empty? ? {} : JSON.parse(raw)
  rescue JSON::ParserError
    halt 400, { error: 'malformed JSON body' }.to_json
  end

  error ActiveRecord::RecordInvalid do
    status 422
    { error: 'validation_failed', detail: env['sinatra.error'].record.errors.full_messages }.to_json
  end

  error ActiveRecord::RecordNotFound do
    status 404
    { error: 'not_found' }.to_json
  end

  error StandardError do
    status 500
    { error: 'agent_error', detail: env['sinatra.error'].message }.to_json
  end

  # ------------------------------------------------------------------ health

  get '/health' do
    { ok: true, postal: Postal::VERSION.to_s }.to_json
  rescue StandardError
    { ok: true }.to_json
  end

  get '/health/queue' do
    {
      queued: QueuedMessage.where(locked_by: nil).count,
      held: QueuedMessage.where.not(locked_by: nil).count,
      workers: Worker.where('last_seen_at > ?', 5.minutes.ago).count,
    }.to_json
  rescue StandardError => e
    { queued: 0, held: 0, workers: 0, note: e.message }.to_json
  end

  # ----------------------------------------------------------- organizations

  post '/organizations' do
    org = Organization.create!(
      name: @body.fetch('name'),
      permalink: @body.fetch('permalink'),
      owner: User.first,
    )
    org_json(org)
  end

  delete '/organizations/:permalink' do
    Organization.find_by!(permalink: params[:permalink]).destroy!
    status 204
  end

  # ----------------------------------------------------------------- servers

  post '/servers' do
    org = Organization.find_by!(permalink: @body.fetch('organizationPermalink'))
    server = org.servers.create!(
      name: @body.fetch('name'),
      permalink: @body.fetch('permalink'),
      mode: @body.fetch('mode', 'Live'),
    )
    assign_pool(server, @body['ipPoolName'])
    server_json(server)
  end

  patch '/servers/*' do
    server = find_server(params['splat'].first)
    attrs = {}
    attrs[:send_limit] = @body['sendLimit'] if @body.key?('sendLimit')
    attrs[:message_retention_days] = @body['messageRetentionDays'] if @body.key?('messageRetentionDays')
    attrs[:raw_message_retention_days] = @body['rawMessageRetentionDays'] if @body.key?('rawMessageRetentionDays')
    attrs[:spam_threshold] = @body['spamThreshold'] if @body.key?('spamThreshold')
    server.update!(attrs) if attrs.any?
    assign_pool(server, @body['ipPoolName']) if @body['ipPoolName']
    server_json(server.reload)
  end

  post '/servers/*/suspend' do
    server = find_server(params['splat'].first)
    server.update!(suspended_at: Time.now, suspension_reason: @body.fetch('reason', 'suspended'))
    status 204
  end

  post '/servers/*/unsuspend' do
    find_server(params['splat'].first).update!(suspended_at: nil, suspension_reason: nil)
    status 204
  end

  # ----------------------------------------------------------------- domains

  # Postal generates the DKIM keypair on create. Never fabricate these records.
  post '/servers/*/domains' do
    server = find_server(params['splat'].first)
    domain = server.domains.create!(name: @body.fetch('name'))
    domain_json(domain)
  end

  get '/servers/*/domains/*' do
    server = find_server(params['splat'][0])
    domain_json(server.domains.find_by!(name: params['splat'][1]))
  end

  post '/servers/*/domains/*/check' do
    server = find_server(params['splat'][0])
    domain = server.domains.find_by!(name: params['splat'][1])
    domain.check_dns(:manual)
    domain_json(domain.reload)
  end

  delete '/servers/*/domains/*' do
    server = find_server(params['splat'][0])
    server.domains.find_by!(name: params['splat'][1]).destroy!
    status 204
  end

  # ------------------------------------------------------------- credentials

  post '/servers/*/credentials' do
    server = find_server(params['splat'].first)
    credential = server.credentials.build(
      type: @body.fetch('type'),
      name: @body.fetch('name'),
    )
    credential.key = @body['key'] if @body['key']
    credential.save!
    credential_json(credential)
  end

  delete '/servers/*/credentials/:id' do
    server = find_server(params['splat'].first)
    server.credentials.find(params[:id]).destroy!
    status 204
  end

  # Pause without revoking: sending stops, the credentials survive so resume
  # does not require the customer to re-key their application.
  post '/servers/*/credentials/hold' do
    server = find_server(params['splat'].first)
    server.credentials.update_all(hold: !!@body.fetch('hold'))
    status 204
  end

  # ------------------------------------------------------------------ routes

  post '/servers/*/routes' do
    server = find_server(params['splat'].first)
    domain = server.domains.find_by!(name: @body.fetch('domain'))
    endpoint = server.http_endpoints.create!(
      name: "#{@body.fetch('name')}@#{domain.name}",
      url: @body.fetch('endpointUrl'),
      encoding: 'BodyAsJSON',
      format: 'Hash',
    )
    route = server.routes.create!(
      name: @body.fetch('name'),
      domain: domain,
      endpoint: endpoint,
      mode: @body.fetch('mode', 'Endpoint'),
    )
    { id: route.id, endpoint_id: endpoint.id }.to_json
  end

  delete '/servers/*/routes/:id' do
    server = find_server(params['splat'].first)
    server.routes.find(params[:id]).destroy!
    status 204
  end

  # --------------------------------------------------------------- IP pools

  get '/ip_pools' do
    IPPool.all.map { |p| pool_hash(p) }.to_json
  end

  post '/ip_pools' do
    pool_hash(IPPool.create!(name: @body.fetch('name'))).to_json
  end

  post '/ip_pools/:name/addresses' do
    pool = IPPool.find_by!(name: params[:name])
    pool.ip_addresses.create!(
      ipv4: @body.fetch('ipv4'),
      hostname: @body.fetch('hostname'),
    )
    status 204
  end

  post '/ip_pools/:name/organizations' do
    pool = IPPool.find_by!(name: params[:name])
    org = Organization.find_by!(permalink: @body.fetch('organizationPermalink'))
    org.ip_pools << pool unless org.ip_pools.include?(pool)
    status 204
  end

  # --------------------------------------------------------------- helpers

  private

  # The control plane addresses servers as "org-permalink/server-permalink",
  # which is how Postal's own URLs identify them.
  def find_server(path)
    org_permalink, server_permalink = path.split('/', 2)
    org = Organization.find_by!(permalink: org_permalink)
    org.servers.find_by!(permalink: server_permalink)
  end

  def assign_pool(server, pool_name)
    return if pool_name.nil?

    pool = IPPool.find_by(name: pool_name)
    return if pool.nil?

    server.organization.ip_pools << pool unless server.organization.ip_pools.include?(pool)
    server.update!(ip_pool: pool)
  end

  def org_json(org)
    { id: org.id, permalink: org.permalink, name: org.name }.to_json
  end

  def server_json(server)
    {
      id: server.id,
      permalink: server.permalink,
      name: server.name,
      organization_permalink: server.organization.permalink,
      mode: server.mode,
      ip_pool_id: server.ip_pool_id,
    }.to_json
  end

  def domain_json(domain)
    {
      id: domain.id,
      name: domain.name,
      verified: domain.verified?,
      spf_status: domain.spf_status,
      spf_error: domain.spf_error,
      dkim_status: domain.dkim_status,
      dkim_error: domain.dkim_error,
      mx_status: domain.mx_status,
      mx_error: domain.mx_error,
      return_path_status: domain.return_path_status,
      return_path_error: domain.return_path_error,
      dkim_record: domain.dkim_record,
      dkim_record_name: domain.dkim_record_name,
      spf_record: domain.spf_record,
      return_path_record: domain.return_path_domain,
      verification_token: domain.verification_token,
    }.to_json
  end

  def credential_json(credential)
    {
      id: credential.id,
      type: credential.type,
      name: credential.name,
      key: credential.key,
      hold: credential.hold,
    }.to_json
  end

  def pool_hash(pool)
    {
      id: pool.id,
      name: pool.name,
      ip_addresses: pool.ip_addresses.map { |a| { id: a.id, ipv4: a.ipv4, hostname: a.hostname } },
    }
  end

  run! if app_file == $PROGRAM_NAME
end
