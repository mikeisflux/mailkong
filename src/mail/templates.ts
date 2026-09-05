import { config } from '../config.js'

/**
 * Platform email.
 *
 * Deliberately plain: these are transactional messages that must render in
 * every client including text-only ones, and must never look like marketing.
 * Every template returns both parts -- a text-only fallback is what keeps
 * these out of spam folders.
 */

interface Rendered {
  subject: string
  html: string
  text: string
}

const BRAND = 'Mailkong'

function layout(heading: string, bodyHtml: string, cta?: { label: string; url: string }): string {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f7f9fb;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f9fb;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e3e8ef;border-radius:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<tr><td style="padding:26px 28px 0;">
  <div style="font-weight:700;font-size:17px;color:#0d1117;letter-spacing:-.02em;">${BRAND}</div>
</td></tr>
<tr><td style="padding:18px 28px 0;">
  <h1 style="margin:0 0 14px;font-size:19px;line-height:1.3;color:#0d1117;font-weight:650;">${heading}</h1>
  <div style="font-size:15px;line-height:1.6;color:#3d4a5c;">${bodyHtml}</div>
</td></tr>
${
  cta
    ? `<tr><td style="padding:22px 28px 0;">
  <a href="${cta.url}" style="display:inline-block;background:#3538cd;color:#ffffff;text-decoration:none;padding:11px 22px;border-radius:8px;font-size:15px;font-weight:600;">${cta.label}</a>
  <p style="margin:16px 0 0;font-size:13px;color:#6b7a8d;line-height:1.5;">
    If the button does not work, copy this link:<br>
    <span style="color:#3538cd;word-break:break-all;">${cta.url}</span>
  </p>
</td></tr>`
    : ''
}
<tr><td style="padding:26px 28px 28px;">
  <hr style="border:none;border-top:1px solid #e3e8ef;margin:0 0 14px;">
  <p style="margin:0;font-size:12px;color:#6b7a8d;line-height:1.5;">
    Sent by ${BRAND}. If you were not expecting this, you can ignore it safely.
  </p>
</td></tr>
</table>
</td></tr></table>
</body></html>`
}

export const templates = {
  verifyEmail(input: { name: string | null; url: string }): Rendered {
    return {
      subject: 'Confirm your email address',
      html: layout(
        'Confirm your email address',
        `<p>Hi${input.name ? ` ${escape(input.name)}` : ''}, confirm this address to finish setting up your ${BRAND} account.</p>
         <p>This link expires in 24 hours.</p>`,
        { label: 'Confirm email', url: input.url },
      ),
      text: `Confirm your email address\n\nHi${input.name ? ` ${input.name}` : ''}, confirm this address to finish setting up your ${BRAND} account.\n\n${input.url}\n\nThis link expires in 24 hours. If you were not expecting this, ignore it.`,
    }
  },

  magicLink(input: { url: string }): Rendered {
    return {
      subject: `Your ${BRAND} sign-in link`,
      html: layout(
        'Sign in to Mailkong',
        `<p>Click below to sign in. The link works once and expires in 15 minutes.</p>`,
        { label: 'Sign in', url: input.url },
      ),
      text: `Sign in to ${BRAND}\n\n${input.url}\n\nThe link works once and expires in 15 minutes. If you did not request it, ignore this email — nobody can sign in without it.`,
    }
  },

  passwordReset(input: { url: string }): Rendered {
    return {
      subject: 'Reset your password',
      html: layout(
        'Reset your password',
        `<p>Use the link below to choose a new password. It expires in one hour and can only be used once.</p>
         <p>Your current password stays active until you set a new one.</p>`,
        { label: 'Choose a new password', url: input.url },
      ),
      text: `Reset your password\n\n${input.url}\n\nExpires in one hour, single use. Your current password stays active until you set a new one.\n\nIf you did not request this, ignore it — your account is unchanged.`,
    }
  },

  invite(input: { organization: string; inviterEmail: string; role: string; url: string }): Rendered {
    return {
      subject: `You have been invited to ${input.organization} on ${BRAND}`,
      html: layout(
        `Join ${escape(input.organization)}`,
        `<p><strong>${escape(input.inviterEmail)}</strong> invited you to join
          <strong>${escape(input.organization)}</strong> on ${BRAND} as
          <strong>${input.role.toLowerCase().replace(/_/g, ' ')}</strong>.</p>
         <p>This invitation expires in 7 days.</p>`,
        { label: 'Accept invitation', url: input.url },
      ),
      text: `Join ${input.organization}\n\n${input.inviterEmail} invited you to join ${input.organization} on ${BRAND} as ${input.role.toLowerCase().replace(/_/g, ' ')}.\n\n${input.url}\n\nExpires in 7 days.`,
    }
  },

  bounceSpike(input: { organization: string; rate: number; reason: string; url: string }): Rendered {
    return {
      subject: `Action needed: sending paused on ${input.organization}`,
      html: layout(
        'Sending has been paused',
        `<p>We paused sending on <strong>${escape(input.organization)}</strong> automatically.</p>
         <p style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px;color:#b91c1c;">
           ${escape(input.reason)}
         </p>
         <p>Your dashboard still works and no data has been lost. A high bounce rate usually
         means mail is going to addresses that no longer exist — check where the list came
         from before resuming.</p>
         <p>Reply to this email and we will review it with you.</p>`,
        { label: 'Open your dashboard', url: input.url },
      ),
      text: `Sending has been paused\n\nWe paused sending on ${input.organization} automatically.\n\n${input.reason}\n\nYour dashboard still works and no data has been lost. A high bounce rate usually means mail is going to addresses that no longer exist.\n\n${input.url}\n\nReply to this email and we will review it with you.`,
    }
  },

  capWarning(input: { organization: string; used: number; limit: number; url: string }): Rendered {
    const pct = Math.round((input.used / input.limit) * 100)
    return {
      subject: `${pct}% of your monthly send allowance used`,
      html: layout(
        `You have used ${pct}% of this month's allowance`,
        `<p><strong>${escape(input.organization)}</strong> has sent
          ${input.used.toLocaleString()} of ${input.limit.toLocaleString()} messages this period.</p>
         <p>When you reach the limit, sending stops and the API returns a clear error rather
         than billing you for overage. Upgrading takes effect immediately.</p>`,
        { label: 'Review usage', url: input.url },
      ),
      text: `You have used ${pct}% of this month's allowance\n\n${input.organization} has sent ${input.used.toLocaleString()} of ${input.limit.toLocaleString()} messages this period.\n\nWhen you reach the limit, sending stops and the API returns a clear error rather than billing you for overage.\n\n${input.url}`,
    }
  },

  webhookFailing(input: { organization: string; url: string; failures: number; dashboardUrl: string }): Rendered {
    return {
      subject: 'A webhook endpoint is failing',
      html: layout(
        'A webhook endpoint is failing',
        `<p>Deliveries to <code style="background:#f1f5f9;padding:2px 6px;border-radius:4px;">${escape(input.url)}</code>
          have failed ${input.failures} times in a row.</p>
         <p>We keep retrying with backoff. After 50 consecutive failures the endpoint is
         disabled and you will need to re-enable it.</p>`,
        { label: 'View delivery log', url: input.dashboardUrl },
      ),
      text: `A webhook endpoint is failing\n\nDeliveries to ${input.url} have failed ${input.failures} times in a row.\n\nWe keep retrying with backoff. After 50 consecutive failures the endpoint is disabled.\n\n${input.dashboardUrl}`,
    }
  },

  invoiceFailed(input: { organization: string; url: string }): Rendered {
    return {
      subject: 'Your payment did not go through',
      html: layout(
        'Payment failed',
        `<p>The most recent invoice for <strong>${escape(input.organization)}</strong> could not be charged.</p>
         <p>Sending is paused until the payment succeeds. Your data, domains and credentials
         are all intact — updating your card resumes sending immediately.</p>`,
        { label: 'Update payment method', url: input.url },
      ),
      text: `Payment failed\n\nThe most recent invoice for ${input.organization} could not be charged.\n\nSending is paused until the payment succeeds. Your data, domains and credentials are intact — updating your card resumes sending immediately.\n\n${input.url}`,
    }
  },

  domainVerified(input: { domain: string; url: string }): Rendered {
    return {
      subject: `${input.domain} is verified`,
      html: layout(
        `${escape(input.domain)} is verified`,
        `<p>SPF and DKIM both pass. Your account is active and you can send from
          <strong>${escape(input.domain)}</strong> now.</p>`,
        { label: 'Send a test message', url: input.url },
      ),
      text: `${input.domain} is verified\n\nSPF and DKIM both pass. Your account is active and you can send from ${input.domain} now.\n\n${input.url}`,
    }
  },

  domainBroken(input: { domain: string; detail: string; url: string }): Rendered {
    return {
      subject: `DNS for ${input.domain} has stopped resolving`,
      html: layout(
        `DNS for ${escape(input.domain)} is failing`,
        `<p>This domain was verified, but its records no longer resolve correctly.
          Mail from it will be rejected or filtered until this is fixed.</p>
         <p style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:12px;color:#b45309;font-family:monospace;font-size:13px;">
           ${escape(input.detail)}
         </p>`,
        { label: 'Review DNS records', url: input.url },
      ),
      text: `DNS for ${input.domain} is failing\n\nThis domain was verified, but its records no longer resolve correctly. Mail from it will be rejected or filtered until this is fixed.\n\n${input.detail}\n\n${input.url}`,
    }
  },
}

/** Everything interpolated into HTML is user-controlled. Escape all of it. */
function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
}

export const appUrl = (path = '') => `${config.APP_URL}${path}`
