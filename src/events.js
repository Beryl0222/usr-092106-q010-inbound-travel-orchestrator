/**
 * 构造领域事件：版本号由存储内对应聚合的当前进度推导，
 * 保证同一聚合内从 1 起连续递增，调用方无需自行维护序号。
 */
export function makeEvent(store, { event_id, event_type, aggregate_type, aggregate_id, occurred_at, summary, payload }) {
  return {
    event_id,
    event_type,
    aggregate_type,
    aggregate_id,
    occurred_at,
    version: store.nextVersion(aggregate_type, aggregate_id),
    summary,
    ...(payload ? { payload } : {}),
  };
}
