/** Slugs never claimable publicly (platform + abuse-prone names). */
export const RESERVED_SLUGS_PUBLIC = new Set([
  'notifications', 'applications', 'admin', 'system', 'wwwadmin', 'mailer',
  'postmaster', 'webmaster', 'security', 'billing', 'support', 'contact',
  'collective', 'official', 'moderation', 'abuseteam',
])
