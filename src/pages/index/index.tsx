import { useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { View, Text, ScrollView } from '@tarojs/components';
import { Button, Cell, CellGroup, Empty, Input, NoticeBar, Radio, RadioGroup, Tag, TextArea } from '@nutui/nutui-react-taro';
import { useI18n } from '../../i18n';
import {
  addObservation,
  addPoint,
  addSample,
  clearNotice,
  clearRejection,
  resolveField,
  reviewObservation,
  reviewSample,
  setRole,
  syncPending,
  updatePoint,
  verifySample,
} from '../../store';
import type { AppDispatch, RootState } from '../../store';
import type { FieldConflict, PatrolObservation, RiskLevel, Sample, SyncState, TrackPoint } from '../../sync/types';
import './index.scss';

const RISK_LABEL: Record<RiskLevel, string> = { low: '低', medium: '中', high: '高' };
const RISK_COLOR: Record<RiskLevel, string> = { low: '#1f6f50', medium: '#e6a23c', high: '#d9534f' };
const SYNC_LABEL: Record<SyncState, string> = {
  local: '本地',
  queued: '待上传',
  uploading: '上传中',
  synced: '已同步',
  conflict: '冲突待确认',
  failed: '失败待重试',
};
const SYNC_COLOR: Record<SyncState, string> = {
  local: '#909399',
  queued: '#409eff',
  uploading: '#e6a23c',
  synced: '#67c23a',
  conflict: '#d9534f',
  failed: '#d9534f',
};

function SectionTitle({ children, extra }: { children: React.ReactNode; extra?: string }) {
  return (
    <View className="section-title">
      <Text className="section-title-text">{children}</Text>
      {extra ? <Text className="section-title-extra">{extra}</Text> : null}
    </View>
  );
}

function SyncTag({ state }: { state: SyncState }) {
  return (
    <Tag background={SYNC_COLOR[state]} className="sync-tag">
      {SYNC_LABEL[state]}
    </Tag>
  );
}

function ConflictBlock({
  conflict,
  isManager,
  onResolve,
}: {
  conflict: FieldConflict;
  isManager: boolean;
  onResolve: (choice: 'local' | 'server') => void;
}) {
  return (
    <View className="conflict-block">
      <View className="conflict-head">
        <Text className="conflict-field">{conflict.label}</Text>
        <Tag background="#d9534f">字段冲突</Tag>
      </View>
      <View className="conflict-versions">
        <View className="conflict-version">
          <Text className="version-label">本地版本</Text>
          <Text className="version-value">{String(conflict.localValue ?? '—')}</Text>
        </View>
        <View className="conflict-version">
          <Text className="version-label">站里版本</Text>
          <Text className="version-value">{String(conflict.serverValue ?? '—')}</Text>
        </View>
      </View>
      {isManager ? (
        <View className="conflict-actions">
          <Button size="small" fill="outline" onClick={() => onResolve('local')}>取本地</Button>
          <Button size="small" type="primary" onClick={() => onResolve('server')}>取站里</Button>
        </View>
      ) : (
        <Text className="conflict-hint">两边各执一份，待负责人确认</Text>
      )}
    </View>
  );
}

function ObservationCard({ obs }: { obs: PatrolObservation }) {
  const dispatch = useDispatch<AppDispatch>();
  const role = useSelector((s: RootState) => s.patrol.role);
  const isManager = role === 'manager';
  return (
    <View className="record-card">
      <View className="record-row">
        <Text className="record-time">{obs.time}</Text>
        <SyncTag state={obs.sync} />
      </View>
      <Text className="record-note">{obs.note}</Text>
      <View className="record-row">
        <Tag background={RISK_COLOR[obs.risk]}>风险 {RISK_LABEL[obs.risk]}</Tag>
        <Tag background={obs.reviewed ? '#67c23a' : '#909399'}>{obs.reviewed ? '已复核' : '未复核'}</Tag>
      </View>
      {obs.conflicts && obs.conflicts.length > 0
        ? obs.conflicts.map((c) => (
            <ConflictBlock
              key={c.field}
              conflict={c}
              isManager={isManager}
              onResolve={(choice) => dispatch(resolveField({ kind: 'observation', id: obs.id, field: c.field, choice }))}
            />
          ))
        : null}
      {isManager && !obs.reviewed && obs.sync !== 'conflict' ? (
        <Button size="small" type="primary" className="record-action" onClick={() => dispatch(reviewObservation(obs.id))}>
          负责人复核
        </Button>
      ) : null}
    </View>
  );
}

function PointCard({ point }: { point: TrackPoint }) {
  const dispatch = useDispatch<AppDispatch>();
  const [editing, setEditing] = useState(false);
  const [lat, setLat] = useState(String(point.latitude));
  const [lng, setLng] = useState(String(point.longitude));
  const linkedSamples = useSelector((s: RootState) => s.patrol.samples.filter((sm) => sm.pointId === point.id));
  const save = () => {
    const la = parseFloat(lat);
    const ln = parseFloat(lng);
    if (Number.isFinite(la) && Number.isFinite(ln)) {
      dispatch(updatePoint({ id: point.id, latitude: la, longitude: ln }));
      setEditing(false);
    }
  };
  return (
    <View className="record-card">
      <View className="record-row">
        <Text className="record-time">{point.at}</Text>
        <SyncTag state={point.sync} />
      </View>
      <Text className="record-note">
        {point.latitude.toFixed(4)}, {point.longitude.toFixed(4)}
      </Text>
      <Text className="record-meta">来源：{point.source === 'gps' ? 'GPS' : '手动'}</Text>
      {linkedSamples.length > 0 ? (
        <Text className="record-meta warn">关联 {linkedSamples.length} 个样本，坐标变更将作废其核验</Text>
      ) : null}
      {editing ? (
        <View className="point-edit">
          <Input value={lat} onChange={setLat} placeholder="纬度" type="digit" />
          <Input value={lng} onChange={setLng} placeholder="经度" type="digit" />
          <View className="conflict-actions">
            <Button size="small" fill="outline" onClick={() => setEditing(false)}>取消</Button>
            <Button size="small" type="primary" onClick={save}>保存坐标</Button>
          </View>
        </View>
      ) : (
        <Button size="small" fill="outline" className="record-action" onClick={() => { setLat(String(point.latitude)); setLng(String(point.longitude)); setEditing(true); }}>
          修改坐标
        </Button>
      )}
    </View>
  );
}

function SampleCard({ sample }: { sample: Sample }) {
  const dispatch = useDispatch<AppDispatch>();
  const role = useSelector((s: RootState) => s.patrol.role);
  const isManager = role === 'manager';
  const statusLabel = sample.status === 'verified' ? '已核验' : sample.status === 'submitted' ? '已提交' : '草稿';
  const verifLabel = sample.verification
    ? sample.verification.conclusion === 'normal'
      ? '核验正常'
      : '核验异常'
    : '未核验';
  const verifColor = sample.verification
    ? sample.verification.conclusion === 'normal'
      ? '#67c23a'
      : '#d9534f'
    : '#909399';
  return (
    <View className="record-card">
      <View className="record-row">
        <Text className="record-time">{sample.code}</Text>
        <SyncTag state={sample.sync} />
      </View>
      <Text className="record-note">{sample.species} × {sample.count}</Text>
      <Text className="record-meta">状态：{statusLabel}{sample.pointId ? ` · 关联点 ${sample.pointId}` : ''}</Text>
      <View className="record-row">
        <Tag background={verifColor}>{verifLabel}</Tag>
        <Tag background={sample.reviewed ? '#67c23a' : '#909399'}>{sample.reviewed ? '已复核' : '未复核'}</Tag>
      </View>
      {sample.conflicts && sample.conflicts.length > 0
        ? sample.conflicts.map((c) => (
            <ConflictBlock
              key={c.field}
              conflict={c}
              isManager={isManager}
              onResolve={(choice) => dispatch(resolveField({ kind: 'sample', id: sample.id, field: c.field, choice }))}
            />
          ))
        : null}
      {isManager ? (
        <View className="conflict-actions">
          <Button size="small" type="primary" onClick={() => dispatch(verifySample(sample.id))}>样本核验</Button>
          {!sample.reviewed ? (
            <Button size="small" fill="outline" onClick={() => dispatch(reviewSample(sample.id))}>负责人复核</Button>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function AddObservationForm() {
  const dispatch = useDispatch<AppDispatch>();
  const [note, setNote] = useState('');
  const [risk, setRisk] = useState<RiskLevel>('low');
  const submit = () => {
    if (!note.trim()) return;
    dispatch(addObservation({ note: note.trim(), risk }));
    setNote('');
    setRisk('low');
  };
  return (
    <View className="add-form">
      <TextArea value={note} onChange={setNote} placeholder="现场情况" />
      <RadioGroup
        value={risk}
        onChange={(v) => setRisk(v as RiskLevel)}
        direction="horizontal"
        options={[
          { label: '低', value: 'low' },
          { label: '中', value: 'medium' },
          { label: '高', value: 'high' },
        ]}
      />
      <Button block type="primary" onClick={submit}>保存现场记录</Button>
    </View>
  );
}

function AddPointForm() {
  const dispatch = useDispatch<AppDispatch>();
  const [lat, setLat] = useState('30.58');
  const [lng, setLng] = useState('103.21');
  const submit = () => {
    const la = parseFloat(lat);
    const ln = parseFloat(lng);
    if (!Number.isFinite(la) || !Number.isFinite(ln)) return;
    dispatch(addPoint({ latitude: la, longitude: ln }));
  };
  return (
    <View className="add-form">
      <Input value={lat} onChange={setLat} placeholder="纬度" type="digit" />
      <Input value={lng} onChange={setLng} placeholder="经度" type="digit" />
      <Button block type="primary" onClick={submit}>记录轨迹点</Button>
    </View>
  );
}

function AddSampleForm() {
  const dispatch = useDispatch<AppDispatch>();
  const points = useSelector((s: RootState) => s.patrol.points);
  const [code, setCode] = useState('');
  const [species, setSpecies] = useState('');
  const [count, setCount] = useState('1');
  const [pointId, setPointId] = useState<string | undefined>(undefined);
  const submit = () => {
    if (!code.trim() || !species.trim()) return;
    dispatch(addSample({ code: code.trim(), species: species.trim(), count: parseInt(count, 10) || 1, pointId }));
    setCode('');
    setSpecies('');
    setCount('1');
    setPointId(undefined);
  };
  const pointOptions = [
    { label: '不关联', value: '' },
    ...points.map((p) => ({ label: `${p.id} (${p.latitude.toFixed(3)},${p.longitude.toFixed(3)})`, value: p.id })),
  ];
  return (
    <View className="add-form">
      <Input value={code} onChange={setCode} placeholder="样本编号" />
      <Input value={species} onChange={setSpecies} placeholder="物种" />
      <Input value={count} onChange={setCount} placeholder="数量" type="number" />
      <RadioGroup
        value={pointId ?? ''}
        onChange={(v) => setPointId(v ? String(v) : undefined)}
        direction="horizontal"
        options={pointOptions}
      />
      <Button block type="primary" onClick={submit}>提交样本</Button>
    </View>
  );
}

export default function Index() {
  const t = useI18n();
  const dispatch = useDispatch<AppDispatch>();
  const { role, observations, points, samples, syncing, lastSync, rejection, notice } = useSelector((s: RootState) => s.patrol);

  const stats = useMemo(() => {
    const all = [...observations, ...points, ...samples];
    return {
      synced: all.filter((r) => r.sync === 'synced').length,
      pending: all.filter((r) => r.sync === 'queued' || r.sync === 'failed').length,
      conflict: all.filter((r) => r.sync === 'conflict').length,
      failed: all.filter((r) => r.sync === 'failed').length,
    };
  }, [observations, points, samples]);

  const onSync = () => {
    dispatch(syncPending());
  };

  return (
    <ScrollView scrollY className="page">
      {rejection ? (
        <NoticeBar
          content={rejection}
          closeable
          onClose={() => dispatch(clearRejection())}
          className="notice notice-danger"
        />
      ) : null}
      {notice ? (
        <NoticeBar
          content={notice}
          closeable
          onClose={() => dispatch(clearNotice())}
          className="notice notice-info"
        />
      ) : null}

      <CellGroup title={t.roleSwitch}>
        <Cell>
          <RadioGroup
            value={role}
            onChange={(v) => dispatch(setRole(v as 'ranger' | 'manager'))}
            direction="horizontal"
            options={[
              { label: t.roleRanger, value: 'ranger' },
              { label: t.roleManager, value: 'manager' },
            ]}
          />
        </Cell>
      </CellGroup>

      <CellGroup title={t.sync}>
        <View className="sync-panel">
          <View className="sync-stats">
            <Text className="sync-stat">已同步 {stats.synced}</Text>
            <Text className="sync-stat">待传 {stats.pending}</Text>
            <Text className="sync-stat">失败 {stats.failed}</Text>
            <Text className="sync-stat">冲突 {stats.conflict}</Text>
          </View>
          <Button block type="primary" loading={syncing} onClick={onSync} disabled={syncing || stats.pending === 0}>
            {syncing ? t.syncing : stats.failed > 0 ? t.retryFailed : t.syncNow}
          </Button>
          {lastSync ? (
            <Text className="last-sync">
              上次：新传 {lastSync.synced} · 失败 {lastSync.failed} · 冲突 {lastSync.conflict} · 跳过 {lastSync.skipped}（已同步不重复上传）
            </Text>
          ) : null}
        </View>
      </CellGroup>

      <SectionTitle extra={`${observations.length}`}>{t.observations}</SectionTitle>
      {observations.length === 0 ? <Empty description={t.emptyObservations} /> : observations.map((o) => <ObservationCard key={o.id} obs={o} />)}
      <AddObservationForm />

      <SectionTitle extra={`${points.length}`}>{t.points}</SectionTitle>
      {points.length === 0 ? <Empty description={t.emptyPoints} /> : points.map((p) => <PointCard key={p.id} point={p} />)}
      <AddPointForm />

      <SectionTitle extra={`${samples.length}`}>{t.samples}</SectionTitle>
      {samples.length === 0 ? <Empty description={t.emptySamples} /> : samples.map((s) => <SampleCard key={s.id} sample={s} />)}
      <AddSampleForm />

      <View className="footer-hint">
        <Text>离线记录保存在本机，联网后逐条合并进站里版本。字段级冲突留待负责人确认，已同步记录重复上传不会多出一份。</Text>
      </View>
    </ScrollView>
  );
}
