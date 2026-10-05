import type { AppState, ObservationDoc, PointDoc, SampleDoc, StationState } from './types';

// 种子数据刻意覆盖：
// o1：上次已同步后，站里单独改了 note（本地没动）→ 同步时没动的字段跟站里值走。
// o3：两边都改了 note，且内容不一致 → 留两份内容，等负责人确认。
// s1：样本已核验，坐标级联演示的对象。
// o4/p3/s2：新产生还没上传的观察/轨迹/样本，用于「中途失败只重试没传完的」。

export function seedStation(): StationState {
  return {
    observations: [
      { clientId: 'o1', time: '2026-10-04 07:20', note: '东坡发现新鲜足迹，沿溪谷方向移动（负责人已补充：疑似豹猫家族群）', risk: 'medium', reviewed: false, pointId: 'p1' },
      { clientId: 'o2', time: '2026-10-04 08:05', note: '红外相机外壳松动，已拍照待补报', risk: 'high', reviewed: false, pointId: 'p2' },
      { clientId: 'o3', time: '2026-10-04 08:40', note: '样线南段没有异常', risk: 'low', reviewed: true, pointId: 'p2' }
    ],
    points: [
      { clientId: 'p1', latitude: 30.5821, longitude: 103.2174, at: '07:20', source: 'gps', coordVersion: 1 },
      { clientId: 'p2', latitude: 30.5856, longitude: 103.2211, at: '08:05', source: 'gps', coordVersion: 1 }
    ],
    samples: [
      { clientId: 's1', code: 'WD-1004-01', species: '疑似豹猫毛发', count: 1, pointId: 'p1', status: 'verified', verifyNote: '核验通过：位于登记样线内，证据完整', verifiedBy: '负责人·周岚', coordVersion: 1 }
    ]
  };
}

export function seedApp(): AppState {
  const o1: ObservationDoc = {
    kind: 'observation', clientId: 'o1', time: '2026-10-04 07:20',
    note: '东坡发现新鲜足迹，沿溪谷方向移动', risk: 'medium',
    sync: 'synced', conflicts: {}, dirtyFields: [], reviewed: false, pointId: 'p1',
    base: { note: '东坡发现新鲜足迹，沿溪谷方向移动', risk: 'medium' }
  };
  const o2: ObservationDoc = {
    kind: 'observation', clientId: 'o2', time: '2026-10-04 08:05',
    note: '红外相机外壳松动，已拍照待补报', risk: 'high',
    sync: 'synced', conflicts: {}, dirtyFields: [], reviewed: false, pointId: 'p2',
    base: { note: '红外相机外壳松动，已拍照待补报', risk: 'high' }
  };
  const o3: ObservationDoc = {
    kind: 'observation', clientId: 'o3', time: '2026-10-04 08:40',
    note: '样线南段没有异常，仅见零星鸟羽', risk: 'low',
    sync: 'queued', conflicts: {}, dirtyFields: ['note'], reviewed: true, pointId: 'p2',
    base: { note: '样线南段没有异常', risk: 'low' }
  };
  // 离线新增，还没上传
  const o4: ObservationDoc = {
    kind: 'observation', clientId: 'o4', time: '2026-10-05 09:12',
    note: '北坡水源地有野猪活动痕迹', risk: 'medium',
    sync: 'queued', conflicts: {}, dirtyFields: ['note', 'risk'], reviewed: false, pointId: 'p3',
    base: null
  };

  const p1: PointDoc = {
    kind: 'point', clientId: 'p1', latitude: 30.5821, longitude: 103.2174, at: '07:20', source: 'gps',
    sync: 'synced', conflicts: {}, dirtyFields: [], coordVersion: 1,
    base: { latitude: 30.5821, longitude: 103.2174 }
  };
  const p2: PointDoc = {
    kind: 'point', clientId: 'p2', latitude: 30.5856, longitude: 103.2211, at: '08:05', source: 'gps',
    sync: 'synced', conflicts: {}, dirtyFields: [], coordVersion: 1,
    base: { latitude: 30.5856, longitude: 103.2211 }
  };
  const p3: PointDoc = {
    kind: 'point', clientId: 'p3', latitude: 30.5901, longitude: 103.2258, at: '09:10', source: 'gps',
    sync: 'queued', conflicts: {}, dirtyFields: ['latitude', 'longitude'], coordVersion: 1,
    base: null
  };

  const s1: SampleDoc = {
    kind: 'sample', clientId: 's1', code: 'WD-1004-01', species: '疑似豹猫毛发', count: 1, pointId: 'p1',
    sync: 'synced', conflicts: {}, dirtyFields: [],
    status: 'verified', verifyNote: '核验通过：位于登记样线内，证据完整', verifiedBy: '负责人·周岚', coordVersion: 1,
    base: { code: 'WD-1004-01', species: '疑似豹猫毛发', count: 1 }
  };
  const s2: SampleDoc = {
    kind: 'sample', clientId: 's2', code: 'WD-1005-02', species: '野猪粪便', count: 2, pointId: 'p3',
    sync: 'queued', conflicts: {}, dirtyFields: ['code', 'species', 'count'],
    status: 'submitted', verifyNote: '已提交，待负责人核验', verifiedBy: '', coordVersion: 1,
    base: null
  };

  return {
    role: 'ranger',
    online: true,
    failNextMidSync: false,
    observations: [o1, o2, o3, o4],
    points: [p1, p2, p3],
    samples: [s1, s2],
    notice: null,
    lastSyncReport: null
  };
}
