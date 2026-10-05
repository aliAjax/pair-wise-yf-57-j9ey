import Taro from '@tarojs/taro';
import type {
  EntityKind,
  Risk,
  SampleStatus,
  StationObservation,
  StationPoint,
  StationSample,
  StationState
} from './types';

// 模拟站点服务端：站里版本持久化在独立存储键里。
// 幂等语义：按「类型 + 客户端ID」做 upsert ——
//   站里没有 → 新建一份；
//   内容完全相同的重复上传 → 判定 duplicate，原样丢弃，总数不变；
//   内容不同（是新的修订）→ 更新同一份，仍然不会多出一条。

const STATION_KEY = 'yf57-station-state';

export function loadStation(fallback: StationState): StationState {
  try {
    const saved = Taro.getStorageSync(STATION_KEY);
    if (saved) return JSON.parse(saved) as StationState;
  } catch {
    /* 读取失败用种子数据 */
  }
  return fallback;
}

export function saveStation(state: StationState) {
  try {
    Taro.setStorageSync(STATION_KEY, JSON.stringify(state));
  } catch {
    /* 存储失败不影响内存态 */
  }
}

// 依据坐标重算样本核验结论（是否位于登记样线范围内）
export function recomputeVerifyNote(p: StationPoint | null): string {
  if (!p) return '位置异常：关联轨迹点缺失，需现场复核';
  const onLine =
    p.latitude >= 30.57 && p.latitude <= 30.6 && p.longitude >= 103.2 && p.longitude <= 103.24;
  return onLine
    ? `按新坐标(${p.latitude.toFixed(4)},${p.longitude.toFixed(4)})自动重算：位于登记样线内，结论成立待负责人确认`
    : `按新坐标(${p.latitude.toFixed(4)},${p.longitude.toFixed(4)})自动重算：偏离登记样线，需现场复核`;
}

/**
 * 坐标级联：轨迹点坐标一变（版本递增），依赖该点的样本核验结论作废重算、
 * 负责人复核重新确认。站里端直接改坐标与上传新坐标都走这里，两端规则一致。
 */
function cascadeCoordinateBump(state: StationState, point: StationPoint) {
  state.samples.forEach((sample) => {
    if (sample.pointId !== point.clientId) return;
    sample.status = 'submitted'; // 已核验作废 → 待负责人重新核验
    sample.verifiedBy = '';
    sample.coordVersion = point.coordVersion;
    sample.verifyNote = recomputeVerifyNote(point);
  });
  state.observations.forEach((obs) => {
    if (obs.pointId === point.clientId) obs.reviewed = false; // 复核重新确认
  });
}

export type UploadResult =
  | { outcome: 'created' }
  | { outcome: 'updated'; changed: boolean }
  | { outcome: 'duplicate' };

/** 幂等上传：同一客户端ID的重复上传不会再多出一份 */
export function uploadObservation(state: StationState, doc: StationObservation): UploadResult {
  const existing = state.observations.find((item) => item.clientId === doc.clientId);
  if (!existing) {
    state.observations.push({ ...doc });
    return { outcome: 'created' };
  }
  if (
    existing.time === doc.time &&
    existing.note === doc.note &&
    existing.risk === doc.risk &&
    existing.reviewed === doc.reviewed &&
    existing.pointId === doc.pointId
  ) {
    return { outcome: 'duplicate' };
  }
  Object.assign(existing, doc);
  return { outcome: 'updated', changed: true };
}

export function uploadPoint(state: StationState, doc: StationPoint): UploadResult {
  const existing = state.points.find((item) => item.clientId === doc.clientId);
  if (!existing) {
    state.points.push({ ...doc });
    return { outcome: 'created' };
  }
  const moved = existing.latitude !== doc.latitude || existing.longitude !== doc.longitude;
  const same =
    !moved &&
    existing.at === doc.at &&
    existing.source === doc.source &&
    existing.coordVersion === doc.coordVersion;
  if (same) return { outcome: 'duplicate' };
  Object.assign(existing, doc);
  if (moved) cascadeCoordinateBump(state, existing);
  return { outcome: 'updated', changed: moved };
}

export function uploadSample(state: StationState, doc: StationSample): UploadResult {
  const existing = state.samples.find((item) => item.clientId === doc.clientId);
  if (!existing) {
    state.samples.push({ ...doc });
    return { outcome: 'created' };
  }
  const same =
    existing.code === doc.code &&
    existing.species === doc.species &&
    existing.count === doc.count &&
    existing.pointId === doc.pointId &&
    existing.status === doc.status &&
    existing.verifyNote === doc.verifyNote &&
    existing.verifiedBy === doc.verifiedBy &&
    existing.coordVersion === doc.coordVersion;
  if (same) return { outcome: 'duplicate' };
  Object.assign(existing, doc);
  return { outcome: 'updated', changed: true };
}

/** 站里直接改记录（模拟负责人在站点端的修改） */
export function stationEditObservation(
  state: StationState,
  clientId: string,
  patch: Partial<Pick<StationObservation, 'note' | 'risk' | 'reviewed'>>
) {
  const item = state.observations.find((entry) => entry.clientId === clientId);
  if (item) Object.assign(item, patch);
}

export function stationEditSample(
  state: StationState,
  clientId: string,
  patch: Partial<Pick<StationSample, 'species' | 'count' | 'code'>>
) {
  const item = state.samples.find((entry) => entry.clientId === clientId);
  if (item) Object.assign(item, patch);
}

/** 站里修正轨迹点坐标：坐标版本+1并级联作废 */
export function stationCorrectPoint(
  state: StationState,
  clientId: string,
  latitude: number,
  longitude: number
): boolean {
  const point = state.points.find((entry) => entry.clientId === clientId);
  if (!point) return false;
  if (point.latitude === latitude && point.longitude === longitude) return false;
  point.latitude = latitude;
  point.longitude = longitude;
  point.coordVersion += 1;
  cascadeCoordinateBump(state, point);
  return true;
}

/** 站里复核观察 / 核验样本 */
export function stationReviewObservation(state: StationState, clientId: string) {
  const item = state.observations.find((entry) => entry.clientId === clientId);
  if (item) item.reviewed = true;
}

export function stationVerifySample(state: StationState, clientId: string, manager: string) {
  const item = state.samples.find((entry) => entry.clientId === clientId);
  if (item) {
    item.status = 'verified';
    item.verifiedBy = manager;
  }
}

export function stationCounts(state: StationState) {
  return { observations: state.observations.length, points: state.points.length, samples: state.samples.length };
}

export type { EntityKind, Risk, SampleStatus };
