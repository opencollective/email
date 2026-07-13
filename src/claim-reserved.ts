/** Slugs never claimable publicly: platform names, common role addresses,
 *  and abuse-prone identities. (Names under 6 chars are already blocked by
 *  the length rule, but are listed anyway in case the rule ever changes.) */
export const RESERVED_SLUGS_PUBLIC = new Set([
  // platform
  'applications', 'notifications', 'collective', 'collectiveemail', 'official',
  'system', 'staging', 'production', 'internal', 'platform',
  // common role addresses
  'hello', 'contact', 'contactus', 'support', 'helpdesk', 'info', 'inquiries',
  'team', 'staff', 'office', 'general', 'welcome', 'onboarding',
  'sales', 'marketing', 'partnerships', 'partners', 'sponsors', 'donations',
  'donate', 'fundraising', 'billing', 'payments', 'invoices', 'finance',
  'accounting', 'treasury', 'legal', 'privacy', 'compliance', 'security',
  'abuse', 'moderation', 'trust', 'safety', 'report', 'reports',
  'press', 'media', 'newsletter', 'newsletters', 'updates', 'announcements',
  'events', 'community', 'members', 'membership', 'volunteers', 'jobs',
  'careers', 'recruiting', 'feedback', 'suggestions', 'complaints',
  // technical
  'admin', 'administrator', 'webmaster', 'postmaster', 'hostmaster',
  'mailer', 'mailerdaemon', 'daemon', 'noreply', 'donotreply', 'bounce',
  'bounces', 'devnull', 'testing', 'sandbox', 'example', 'demonstration',
])
