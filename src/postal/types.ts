/** Wire types for the Postal API. See docs/postal-integration.md. */

export interface PostalSendMessage {
  to: string[]
  cc?: string[]
  bcc?: string[]
  from: string
  sender?: string
  subject: string
  tag?: string
  reply_to?: string
  plain_body?: string
  html_body?: string
  attachments?: Array<{ name: string; content_type: string; data: string }>
  headers?: Record<string, string>
  bounce?: boolean
}

export interface PostalSendResult {
  message_id: string
  messages: Record<string, { id: number; token: string }>
}

export interface PostalMessageDetail {
  id: number
  token: string
  status: string
  last_delivery_attempt?: number
  held?: boolean
  hold_expiry?: number | null
  details?: {
    rcpt_to?: string
    mail_from?: string
    subject?: string
    message_id?: string
    timestamp?: number
    direction?: string
    size?: number
    bounce?: boolean
    tag?: string | null
  }
  status_detail?: { status: string; last_delivery_attempt?: number; details?: string }
  expansions?: Record<string, unknown>
}

export interface PostalDelivery {
  id: number
  status: string
  details: string
  output: string
  sent_with_ssl: boolean
  log_id: string | null
  time: number
  timestamp: number
}

/** Objects the provisioning agent manages on our behalf. */
export interface PostalOrganization {
  id: number
  permalink: string
  name: string
}

export interface PostalServer {
  id: number
  permalink: string
  name: string
  organization_permalink: string
  mode: 'Live' | 'Development'
  ip_pool_id: number | null
}

export interface PostalDomain {
  id: number
  name: string
  verified: boolean
  spf_status: string
  spf_error: string | null
  dkim_status: string
  dkim_error: string | null
  mx_status: string
  mx_error: string | null
  return_path_status: string
  return_path_error: string | null
  dkim_record: string
  dkim_record_name: string
  spf_record: string
  return_path_record: string
  verification_token?: string
}

export interface PostalCredential {
  id: number
  type: 'API' | 'SMTP'
  name: string
  key: string
  hold: boolean
}

export interface PostalIpPool {
  id: number
  name: string
  ip_addresses: Array<{ id: number; ipv4: string; hostname: string }>
}

export interface PostalQueueStats {
  queued: number
  held: number
  workers: number
  message_db_size_bytes?: number
}
