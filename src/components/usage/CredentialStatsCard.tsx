import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import {
  buildCandidateUsageSourceIds,
  collectUsageDetails,
  formatCompactNumber,
  normalizeAuthIndex,
  type KeyStats,
} from '@/utils/usage';
import type { GeminiKeyConfig, ProviderKeyConfig, OpenAIProviderConfig } from '@/types';
import type { UsagePayload } from './hooks/useUsageData';
import styles from '@/pages/UsagePage.module.scss';

export interface CredentialStatsCardProps {
  usage: UsagePayload | null;
  keyStats: KeyStats;
  loading: boolean;
  geminiKeys: GeminiKeyConfig[];
  claudeConfigs: ProviderKeyConfig[];
  codexConfigs: ProviderKeyConfig[];
  vertexConfigs: ProviderKeyConfig[];
  openaiProviders: OpenAIProviderConfig[];
}

interface CredentialRow {
  key: string;
  displayName: string;
  type: string;
  success: number;
  failure: number;
  total: number;
  successRate: number;
}

export function CredentialStatsCard({
  usage,
  keyStats,
  loading,
  geminiKeys,
  claudeConfigs,
  codexConfigs,
  vertexConfigs,
  openaiProviders,
}: CredentialStatsCardProps) {
  const { t } = useTranslation();

  const rows = useMemo((): CredentialRow[] => {
    if (!usage) return [];

    const details = collectUsageDetails(usage);
    const fallbackBucketMap = new Map<string, { success: number; failure: number }>();
    details.forEach((detail) => {
      const accountIdentity = detail.account_identity?.trim() || '';
      const authIndexKey = normalizeAuthIndex(detail.auth_index);
      const bucketKey = accountIdentity
        ? `account:${accountIdentity}`
        : detail.source
          ? `source:${detail.source}`
          : authIndexKey
            ? `auth:${authIndexKey}`
            : '';
      if (!bucketKey) return;
      const bucket = fallbackBucketMap.get(bucketKey) ?? { success: 0, failure: 0 };
      if (detail.failed === true) {
        bucket.failure += 1;
      } else {
        bucket.success += 1;
      }
      fallbackBucketMap.set(bucketKey, bucket);
    });

    const result: CredentialRow[] = [];
    const consumedAccountKeys = new Set<string>();
    const consumedFallbackBucketKeys = new Set<string>();

    const addRow = (
      rowKey: string,
      displayName: string,
      type: string,
      accountIdentity: string | null,
      sourceKeys: string[]
    ) => {
      let success = 0;
      let failure = 0;

      const trimmedAccountIdentity = accountIdentity?.trim() || '';
      const accountBucket = trimmedAccountIdentity
        ? keyStats.byAccountIdentity?.[trimmedAccountIdentity]
        : undefined;

      if (accountBucket) {
        success = accountBucket.success;
        failure = accountBucket.failure;
        consumedAccountKeys.add(trimmedAccountIdentity);
        consumedFallbackBucketKeys.add(`account:${trimmedAccountIdentity}`);
      } else {
        sourceKeys.forEach((sourceKey) => {
          const bucket = fallbackBucketMap.get(`source:${sourceKey}`);
          if (!bucket) return;
          success += bucket.success;
          failure += bucket.failure;
          consumedFallbackBucketKeys.add(`source:${sourceKey}`);
        });
      }

      const total = success + failure;
      if (total <= 0) return;

      result.push({
        key: rowKey,
        displayName,
        type,
        success,
        failure,
        total,
        successRate: (success / total) * 100,
      });
    };

    geminiKeys.forEach((c, i) => {
      const displayName = c.prefix?.trim() || `Gemini #${i + 1}`;
      addRow(
        `gemini:${i}`,
        displayName,
        'gemini',
        null,
        buildCandidateUsageSourceIds({ apiKey: c.apiKey, prefix: c.prefix })
      );
    });

    claudeConfigs.forEach((c, i) => {
      const displayName = c.prefix?.trim() || `Claude #${i + 1}`;
      addRow(
        `claude:${i}`,
        displayName,
        'claude',
        null,
        buildCandidateUsageSourceIds({ apiKey: c.apiKey, prefix: c.prefix })
      );
    });

    codexConfigs.forEach((c, i) => {
      const displayName = c.prefix?.trim() || `Codex #${i + 1}`;
      const accountIdentity = c.headers?.['Chatgpt-Account-Id']
        || c.headers?.['chatgpt-account-id']
        || c.headers?.['chatGPT-account-id']
        || c.headers?.['chatgpt_account_id']
        || null;
      addRow(
        `codex:${i}`,
        displayName,
        'codex',
        accountIdentity ? `codex:${String(accountIdentity).trim()}` : null,
        buildCandidateUsageSourceIds({ apiKey: c.apiKey, prefix: c.prefix })
      );
    });

    vertexConfigs.forEach((c, i) => {
      const displayName = c.prefix?.trim() || `Vertex #${i + 1}`;
      addRow(
        `vertex:${i}`,
        displayName,
        'vertex',
        null,
        buildCandidateUsageSourceIds({ apiKey: c.apiKey, prefix: c.prefix })
      );
    });

    openaiProviders.forEach((provider, providerIndex) => {
      const displayName = provider.prefix?.trim() || provider.name || `OpenAI #${providerIndex + 1}`;
      const sourceKeys = new Set<string>();
      buildCandidateUsageSourceIds({ prefix: provider.prefix }).forEach((id) => sourceKeys.add(id));
      (provider.apiKeyEntries || []).forEach((entry) => {
        buildCandidateUsageSourceIds({ apiKey: entry.apiKey }).forEach((id) => sourceKeys.add(id));
      });
      addRow(
        `openai:${providerIndex}`,
        displayName,
        'openai',
        null,
        Array.from(sourceKeys)
      );
    });

    Object.entries(keyStats.byAccountIdentity ?? {}).forEach(([accountIdentity, bucket]) => {
      if (!accountIdentity || consumedAccountKeys.has(accountIdentity)) return;
      const total = bucket.success + bucket.failure;
      if (total <= 0) return;

      consumedFallbackBucketKeys.add(`account:${accountIdentity}`);
      result.push({
        key: `account:${accountIdentity}`,
        displayName: accountIdentity,
        type: '',
        success: bucket.success,
        failure: bucket.failure,
        total,
        successRate: (bucket.success / total) * 100,
      });
    });

    fallbackBucketMap.forEach((bucket, bucketKey) => {
      if (consumedFallbackBucketKeys.has(bucketKey)) return;
      const total = bucket.success + bucket.failure;
      if (total <= 0) return;

      const displayName = bucketKey.startsWith('account:')
        ? bucketKey.slice('account:'.length)
        : bucketKey.startsWith('source:')
          ? bucketKey.slice('source:'.length).replace(/^t:/, '')
          : bucketKey.startsWith('auth:')
            ? bucketKey.slice('auth:'.length)
            : bucketKey;

      result.push({
        key: bucketKey,
        displayName,
        type: '',
        success: bucket.success,
        failure: bucket.failure,
        total,
        successRate: (bucket.success / total) * 100,
      });
    });

    return result.sort((a, b) => b.total - a.total);
  }, [usage, keyStats, geminiKeys, claudeConfigs, codexConfigs, vertexConfigs, openaiProviders]);

  return (
    <Card title={t('usage_stats.credential_stats')} className={styles.detailsFixedCard}>
      {loading ? (
        <div className={styles.hint}>{t('common.loading')}</div>
      ) : rows.length > 0 ? (
        <div className={styles.detailsScroll}>
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>{t('usage_stats.credential_name')}</th>
                  <th>{t('usage_stats.requests_count')}</th>
                  <th>{t('usage_stats.success_rate')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <td className={styles.modelCell}>
                      <span>{row.displayName}</span>
                      {row.type && <span className={styles.credentialType}>{row.type}</span>}
                    </td>
                    <td>
                      <span className={styles.requestCountCell}>
                        <span>{formatCompactNumber(row.total)}</span>
                        <span className={styles.requestBreakdown}>
                          (<span className={styles.statSuccess}>{row.success.toLocaleString()}</span>{' '}
                          <span className={styles.statFailure}>{row.failure.toLocaleString()}</span>)
                        </span>
                      </span>
                    </td>
                    <td>
                      <span
                        className={
                          row.successRate >= 95
                            ? styles.statSuccess
                            : row.successRate >= 80
                              ? styles.statNeutral
                              : styles.statFailure
                        }
                      >
                        {row.successRate.toFixed(1)}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className={styles.hint}>{t('usage_stats.no_data')}</div>
      )}
    </Card>
  );
}
