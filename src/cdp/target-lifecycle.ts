/** CDP events that must be delivered even when ordinary events are dropped. */
export default function isTargetLifecycleEvent(method: string): boolean {
  return (
    method === 'Target.attachedToTarget' ||
    method === 'Target.detachedFromTarget' ||
    method === 'Target.targetInfoChanged'
  )
}
