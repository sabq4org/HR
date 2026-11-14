/** Body the policies page must send when approving or retiring a rule version. */
export function policyActionBody(
  policy: { version: number },
  action: 'approve' | 'retire',
  reason: string,
) {
  return { action, reason, version: policy.version };
}
