function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Builds the HTML email body for an org invitation. All interpolated values
 * are HTML-escaped (org / inviter names are user-controlled).
 */
export function buildInvitationEmail(params: {
  orgName: string;
  inviterName: string;
  role: string;
  acceptUrl: string;
}): { subject: string; html: string } {
  const orgName = escapeHtml(params.orgName);
  const inviterName = escapeHtml(params.inviterName);
  const role = escapeHtml(params.role);
  const acceptUrl = escapeHtml(params.acceptUrl);

  const subject = `You've been invited to join ${orgName} on Pinpoint`;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
  <div style="text-align: center; margin-bottom: 32px;">
    <h1 style="color: #1a1a2e; font-size: 24px; margin: 0;">Pinpoint</h1>
  </div>
  <div style="background: #f8f9fa; border-radius: 8px; padding: 32px; text-align: center;">
    <h2 style="color: #1a1a2e; margin: 0 0 16px;">You're invited!</h2>
    <p style="color: #4a4a5a; font-size: 16px; line-height: 1.5;">
      <strong>${inviterName}</strong> has invited you to join
      <strong>${orgName}</strong> as a <strong>${role}</strong>.
    </p>
    <a href="${acceptUrl}"
       style="display: inline-block; margin-top: 24px; padding: 12px 32px; background: #4f46e5; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 600;">
      Accept Invitation
    </a>
    <p style="color: #6b7280; font-size: 13px; margin-top: 24px;">
      This invitation expires in 7 days.
    </p>
  </div>
  <p style="color: #9ca3af; font-size: 12px; text-align: center; margin-top: 32px;">
    If you didn't expect this invitation, you can safely ignore this email.
  </p>
</body>
</html>`.trim();

  return { subject, html };
}
