import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { CODEX_CONFIG } from '@/components/quota';
import { useQuotaStore } from '@/stores';
import type { AuthFileItem, CodexQuotaState } from '@/types';
import type { SourceInfo, CredentialInfo } from '@/types/sourceInfo';
import {
  calculateCost,
  collectUsageDetails,
  extractTotalTokens,
  formatCompactNumber,
  formatUsd,
  loadModelPrices,
  normalizeAuthIndex,
  type ModelPrice
} from '@/utils/usage';
import { resolveSourceDisplay } from '@/utils/sourceResolver';
import type { UsageData } from '@/pages/MonitorPage';
import styles from '@/pages/MonitorPage.module.scss';

const ALL_FILTER = '__all__';
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

type SortKey =
  | 'displayName'
  | 'requests'
  | 'tokens'
  | 'successRate'
  | 'cost'
  | 'fiveHourCost'
  | 'weeklyCost';
type SortDir = 'asc' | 'desc';

interface MonitorCredentialStatsCardProps {
  data: UsageData | null;
  loading: boolean;
  sourceInfoMap: Map<string, SourceInfo>;
  authFileMap: Map<string, CredentialInfo>;
  authFiles: AuthFileItem[];
}

interface CredentialRow {
  key: string;
  displayName: string;
  type: string;
  authIndex: string | null;
  authFileName: string | null;
  requests: number;
  successCount: number;
  failureCount: number;
  tokens: number;
  cost: number;
  successRate: number;
  quotaKey: string | null;
}

interface CostEvent {
  timestampMs: number;
  cost: number;
}

const toWindowCost = (endMs: number | null, windowMs: number) => {
  if (!endMs || !Number.isFinite(endMs) || endMs <= 0) {
    return null;
  }
  return { endMs, startMs: endMs - windowMs };
};

export function MonitorCredentialStatsCard({
  data,
  loading,
  sourceInfoMap,
  authFileMap,
  authFiles
}: MonitorCredentialStatsCardProps) {
  const { t } = useTranslation();
  const [sortKey, setSortKey] = useState<SortKey>('requests');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [typeFilter, setTypeFilter] = useState(ALL_FILTER);
  const [refreshingKeys, setRefreshingKeys] = useState<Record<string, boolean>>({});
  const modelPrices = useMemo<Record<string, ModelPrice>>(() => loadModelPrices(), []);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const setCodexQuota = useQuotaStore((state) => state.setCodexQuota);

  const codexFileByName = useMemo(() => {
    const map = new Map<string, AuthFileItem>();
    authFiles.forEach((file) => {
      const type = String(file.type || file.provider || '').trim().toLowerCase();
      if (type === 'codex' && file.name) {
        map.set(file.name, file);
      }
    });
    return map;
  }, [authFiles]);

  const codexFileByAuthIndex = useMemo(() => {
    const map = new Map<string, AuthFileItem>();
    authFiles.forEach((file) => {
      const type = String(file.type || file.provider || '').trim().toLowerCase();
      const rawAuthIndex =
        (file as Record<string, unknown>)['auth_index'] ??
        (file as Record<string, unknown>).authIndex;
      const authIndex = normalizeAuthIndex(rawAuthIndex);
      if (type === 'codex' && authIndex) {
        map.set(authIndex, file);
      }
    });
    return map;
  }, [authFiles]);

  const rows = useMemo((): CredentialRow[] => {
    if (!data) return [];

    const details = collectUsageDetails(data);
    const rowMap = new Map<string, CredentialRow>();

    details.forEach((detail) => {
      const authIndex = normalizeAuthIndex(detail.auth_index);
      const sourceInfo = resolveSourceDisplay(detail.source || '', detail.auth_index, sourceInfoMap, authFileMap);
      const authFile =
        (authIndex ? codexFileByAuthIndex.get(authIndex) : undefined) ??
        Array.from(codexFileByName.values()).find((file) => file.name === sourceInfo.displayName);
      const authFileName = authFileMap.get(authIndex || '')?.name ?? authFile?.name ?? null;
      const rowKey = authFileName ? `file:${authFileName}` : authIndex ? `auth:${authIndex}` : `source:${sourceInfo.displayName}`;
      const existing = rowMap.get(rowKey) ?? {
        key: rowKey,
        displayName: (authFileName ?? sourceInfo.displayName) || '-',
        type: (authFileMap.get(authIndex || '')?.type || sourceInfo.type || '').trim().toLowerCase(),
        authIndex,
        authFileName,
        requests: 0,
        successCount: 0,
        failureCount: 0,
        tokens: 0,
        cost: 0,
        successRate: 100,
        quotaKey: authFile?.name ?? null
      };

      existing.requests += 1;
      if (detail.failed === true) {
        existing.failureCount += 1;
      } else {
        existing.successCount += 1;
      }
      existing.tokens += extractTotalTokens(detail);
      existing.cost += calculateCost(detail, modelPrices);
      existing.successRate = existing.requests > 0 ? (existing.successCount / existing.requests) * 100 : 100;
      rowMap.set(rowKey, existing);
    });

    return Array.from(rowMap.values());
  }, [authFileMap, codexFileByAuthIndex, codexFileByName, data, modelPrices, sourceInfoMap]);

  const typeOptions = useMemo(
    () => [
      { value: ALL_FILTER, label: t('usage_stats.filter_all') },
      ...Array.from(new Set(rows.map((row) => row.type).filter(Boolean)))
        .sort((a, b) => a.localeCompare(b))
        .map((type) => ({ value: type, label: type }))
    ],
    [rows, t]
  );

  const filteredRows = useMemo(
    () => rows.filter((row) => typeFilter === ALL_FILTER || row.type === typeFilter),
    [rows, typeFilter]
  );

  const rowCosts = useMemo(() => {
    const result = new Map<string, CostEvent[]>();
    if (!data) return result;

    rows.forEach((row) => {
      result.set(row.key, []);
    });

    collectUsageDetails(data).forEach((detail) => {
      const authIndex = normalizeAuthIndex(detail.auth_index);
      const sourceInfo = resolveSourceDisplay(detail.source || '', detail.auth_index, sourceInfoMap, authFileMap);
      const authFile =
        (authIndex ? codexFileByAuthIndex.get(authIndex) : undefined) ??
        Array.from(codexFileByName.values()).find((file) => file.name === sourceInfo.displayName);
      const authFileName = authFileMap.get(authIndex || '')?.name ?? authFile?.name ?? null;
      const rowKey = authFileName ? `file:${authFileName}` : authIndex ? `auth:${authIndex}` : `source:${sourceInfo.displayName}`;
      const timestampMs = detail.__timestampMs ?? Date.parse(detail.timestamp);
      if (!Number.isFinite(timestampMs) || timestampMs <= 0) return;
      const bucket = result.get(rowKey);
      if (!bucket) return;
      bucket.push({ timestampMs, cost: calculateCost(detail, modelPrices) });
    });

    return result;
  }, [authFileMap, codexFileByAuthIndex, codexFileByName, data, modelPrices, rows, sourceInfoMap]);

  const resolveQuotaKey = useCallback(
    (row: CredentialRow): string | null => {
      if (row.quotaKey && codexFileByName.has(row.quotaKey)) {
        return row.quotaKey;
      }
      if (row.authFileName && codexFileByName.has(row.authFileName)) {
        return row.authFileName;
      }
      if (row.authIndex && codexFileByAuthIndex.has(row.authIndex)) {
        return codexFileByAuthIndex.get(row.authIndex)?.name ?? null;
      }
      return null;
    },
    [codexFileByAuthIndex, codexFileByName]
  );

  const windowCosts = useMemo(() => {
    const result = new Map<string, { fiveHourCost: number | null; weeklyCost: number | null }>();

    rows.forEach((row) => {
      const quotaKey = resolveQuotaKey(row);
      const quotaState = quotaKey ? (codexQuota[quotaKey] as CodexQuotaState | undefined) : undefined;
      const events = rowCosts.get(row.key) ?? [];
      const fiveHourWindow = quotaState?.windows?.find((window) => window.windowKind === 'five-hour' || window.id === 'five-hour');
      const weeklyWindow = quotaState?.windows?.find((window) => window.windowKind === 'weekly' || window.id === 'weekly');
      const fiveHourInfo = toWindowCost(
        fiveHourWindow?.resetAtUnix ? fiveHourWindow.resetAtUnix * 1000 : null,
        FIVE_HOUR_MS
      );
      const weeklyInfo = toWindowCost(
        weeklyWindow?.resetAtUnix ? weeklyWindow.resetAtUnix * 1000 : null,
        WEEK_MS
      );
      const sumInWindow = (startMs: number, endMs: number) =>
        events.reduce(
          (sum, item) => (item.timestampMs >= startMs && item.timestampMs <= endMs ? sum + item.cost : sum),
          0
        );

      result.set(row.key, {
        fiveHourCost: fiveHourInfo ? sumInWindow(fiveHourInfo.startMs, fiveHourInfo.endMs) : null,
        weeklyCost: weeklyInfo ? sumInWindow(weeklyInfo.startMs, weeklyInfo.endMs) : null
      });
    });

    return result;
  }, [codexQuota, resolveQuotaKey, rowCosts, rows]);

  const handleRefreshQuota = useCallback(
    async (row: CredentialRow) => {
      const quotaKey = resolveQuotaKey(row);
      if (!quotaKey) return;
      const authFile = codexFileByName.get(quotaKey);
      if (!authFile) return;

      setRefreshingKeys((prev) => ({ ...prev, [quotaKey]: true }));
      setCodexQuota((prev) => ({
        ...prev,
        [quotaKey]: CODEX_CONFIG.buildLoadingState()
      }));

      try {
        const data = await CODEX_CONFIG.fetchQuota(authFile, t);
        setCodexQuota((prev) => ({
          ...prev,
          [quotaKey]: CODEX_CONFIG.buildSuccessState(data)
        }));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : t('common.unknown_error');
        const status =
          typeof err === 'object' && err !== null && 'status' in err
            ? Number((err as { status?: unknown }).status)
            : undefined;
        setCodexQuota((prev) => ({
          ...prev,
          [quotaKey]: CODEX_CONFIG.buildErrorState(message, Number.isFinite(status) ? status : undefined)
        }));
      } finally {
        setRefreshingKeys((prev) => ({ ...prev, [quotaKey]: false }));
      }
    },
    [codexFileByName, resolveQuotaKey, setCodexQuota, t]
  );

  const getSortValue = useCallback(
    (row: CredentialRow, key: SortKey) => {
      const costs = windowCosts.get(row.key);
      if (key === 'displayName') return row.displayName;
      if (key === 'fiveHourCost') return costs?.fiveHourCost ?? -1;
      if (key === 'weeklyCost') return costs?.weeklyCost ?? -1;
      return row[key];
    },
    [windowCosts]
  );

  const sortedRows = useMemo(() => {
    const direction = sortDir === 'asc' ? 1 : -1;
    return [...filteredRows].sort((a, b) => {
      const aValue = getSortValue(a, sortKey);
      const bValue = getSortValue(b, sortKey);
      if (typeof aValue === 'string' && typeof bValue === 'string') {
        return direction * aValue.localeCompare(bValue);
      }
      return direction * (Number(aValue) - Number(bValue));
    });
  }, [filteredRows, getSortValue, sortDir, sortKey]);

  const handleSort = useCallback(
    (key: SortKey) => {
      if (sortKey === key) {
        setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
        return;
      }
      setSortKey(key);
      setSortDir(key === 'displayName' ? 'asc' : 'desc');
    },
    [sortKey]
  );

  const arrow = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');

  return (
    <Card title={t('usage_stats.credential_stats')} className={styles.monitorCredentialCard}>
      <div className={styles.monitorCredentialToolbar}>
        <div className={styles.monitorCredentialToolbarItem}>
          <span className={styles.filterLabel}>{t('monitor.credential.filter_type')}</span>
          <Select
            value={typeFilter}
            options={typeOptions}
            onChange={setTypeFilter}
            className={styles.monitorCredentialSelect}
            ariaLabel={t('monitor.credential.filter_type')}
            fullWidth={false}
          />
        </div>
      </div>

      {loading ? (
        <div className={styles.monitorCredentialHint}>{t('common.loading')}</div>
      ) : rows.length === 0 ? (
        <div className={styles.monitorCredentialHint}>{t('monitor.no_data')}</div>
      ) : filteredRows.length === 0 ? (
        <div className={styles.monitorCredentialHint}>{t('monitor.credential.no_result')}</div>
      ) : (
        <div className={styles.monitorCredentialScroll}>
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>
                    <button type="button" className={styles.monitorSortButton} onClick={() => handleSort('displayName')}>
                      {t('usage_stats.credential_name')}{arrow('displayName')}
                    </button>
                  </th>
                  <th className={styles.monitorCredentialActionHeader}>{t('monitor.credential.quota')}</th>
                  <th>
                    <button type="button" className={styles.monitorSortButton} onClick={() => handleSort('requests')}>
                      {t('usage_stats.requests_count')}{arrow('requests')}
                    </button>
                  </th>
                  <th>
                    <button type="button" className={styles.monitorSortButton} onClick={() => handleSort('tokens')}>
                      {t('usage_stats.tokens_count')}{arrow('tokens')}
                    </button>
                  </th>
                  <th>
                    <button type="button" className={styles.monitorSortButton} onClick={() => handleSort('successRate')}>
                      {t('usage_stats.success_rate')}{arrow('successRate')}
                    </button>
                  </th>
                  <th>
                    <button type="button" className={styles.monitorSortButton} onClick={() => handleSort('cost')}>
                      {t('usage_stats.total_cost')}{arrow('cost')}
                    </button>
                  </th>
                  <th>
                    <button type="button" className={styles.monitorSortButton} onClick={() => handleSort('fiveHourCost')}>
                      {t('monitor.credential.cost_5h')}{arrow('fiveHourCost')}
                    </button>
                  </th>
                  <th>
                    <button type="button" className={styles.monitorSortButton} onClick={() => handleSort('weeklyCost')}>
                      {t('monitor.credential.cost_7d')}{arrow('weeklyCost')}
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((row) => {
                  const quotaKey = resolveQuotaKey(row);
                  const quotaState = quotaKey ? (codexQuota[quotaKey] as CodexQuotaState | undefined) : undefined;
                  const quotaWindows = (quotaState?.windows ?? [])
                    .filter((window) => window.windowKind === 'five-hour' || window.windowKind === 'weekly' || window.id === 'five-hour' || window.id === 'weekly')
                    .map((window) => ({
                      id: window.id,
                      label: window.labelKey ? t(window.labelKey, window.labelParams ?? {}) : window.label,
                      remainingPercent:
                        typeof window.usedPercent === 'number'
                          ? `${Math.max(0, Math.min(100, Math.round(100 - window.usedPercent)))}%`
                          : '--'
                    }));
                  const quotaCosts = windowCosts.get(row.key);
                  const isRefreshing = quotaKey ? refreshingKeys[quotaKey] === true : false;

                  return (
                    <tr key={row.key}>
                      <td className={styles.monitorCredentialNameCell}>
                        <div className={styles.monitorCredentialNameWrap}>
                          <span>{row.displayName}</span>
                          {row.type ? <span className={styles.monitorCredentialType}>{row.type}</span> : null}
                        </div>
                      </td>
                      <td className={styles.monitorCredentialActionCell}>
                        {quotaKey ? (
                          <div className={styles.monitorCredentialQuotaInline}>
                            <Button
                              variant="secondary"
                              size="sm"
                              className={styles.monitorCredentialRefreshButton}
                              loading={isRefreshing}
                              onClick={() => void handleRefreshQuota(row)}
                            >
                              {t('codex_quota.refresh_button')}
                            </Button>
                            {quotaWindows.length > 0 ? (
                              <div className={styles.monitorQuotaSummary}>
                                {quotaWindows.map((window) => (
                                  <span key={window.id} className={styles.monitorQuotaChip}>
                                    {window.label}: {window.remainingPercent}
                                  </span>
                                ))}
                              </div>
                            ) : (
                              <span className={styles.monitorQuotaMuted}>{t('monitor.credential.no_quota')}</span>
                            )}
                            {quotaState?.status === 'error' && quotaState.error ? (
                              <span className={styles.monitorQuotaError}>{quotaState.error}</span>
                            ) : null}
                          </div>
                        ) : (
                          <span className={styles.monitorQuotaMuted}>--</span>
                        )}
                      </td>
                      <td>
                        <span className={styles.monitorRequestCountCell}>
                          <span>{row.requests.toLocaleString()}</span>
                          <span className={styles.monitorRequestBreakdown}>
                            (<span className={styles.monitorStatSuccess}>{row.successCount.toLocaleString()}</span>{' '}
                            <span className={styles.monitorStatFailure}>{row.failureCount.toLocaleString()}</span>)
                          </span>
                        </span>
                      </td>
                      <td>{formatCompactNumber(row.tokens)}</td>
                      <td>
                        <span
                          className={
                            row.successRate >= 95
                              ? styles.monitorStatSuccess
                              : row.successRate >= 80
                                ? styles.monitorStatNeutral
                                : styles.monitorStatFailure
                          }
                        >
                          {row.successRate.toFixed(1)}%
                        </span>
                      </td>
                      <td>{row.cost > 0 ? formatUsd(row.cost) : '--'}</td>
                      <td>{quotaCosts?.fiveHourCost !== null && quotaCosts?.fiveHourCost !== undefined ? formatUsd(quotaCosts.fiveHourCost) : '--'}</td>
                      <td>{quotaCosts?.weeklyCost !== null && quotaCosts?.weeklyCost !== undefined ? formatUsd(quotaCosts.weeklyCost) : '--'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Card>
  );
}
