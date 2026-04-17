import { useMemo } from 'react';
import type { AuthFileItem } from '@/types';
import {
  calculateStatusBarData,
  normalizeAuthIndex,
  normalizeUsageSourceId,
  type UsageDetail,
} from '@/utils/usage';

export type AuthFileStatusBarData = ReturnType<typeof calculateStatusBarData>;

export const getAuthFileStatusBarCacheKey = (file: AuthFileItem) => {
  const name = String(file.name ?? '').trim();
  const authIndexKey = normalizeAuthIndex(file['auth_index'] ?? file.authIndex) || '';
  const modified = file['modtime'] ?? file.modified ?? file['last_refresh'] ?? file.lastRefresh ?? '';
  return `${name}::${authIndexKey}::${String(modified)}`;
};

export function useAuthFilesStatusBarCache(files: AuthFileItem[], usageDetails: UsageDetail[]) {
  return useMemo(() => {
    const cache = new Map<string, AuthFileStatusBarData>();

    files.forEach((file) => {
      const authIndexKey = normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
      const rawFileName = String(file.name ?? '').trim();
      const sourceKeys = new Set<string>();
      if (rawFileName) {
        const fileNameKey = normalizeUsageSourceId(rawFileName);
        if (fileNameKey) {
          sourceKeys.add(fileNameKey);
        }
        const nameWithoutExt = rawFileName.replace(/\.[^/.]+$/, '');
        if (nameWithoutExt && nameWithoutExt !== rawFileName) {
          const nameWithoutExtKey = normalizeUsageSourceId(nameWithoutExt);
          if (nameWithoutExtKey) {
            sourceKeys.add(nameWithoutExtKey);
          }
        }
      }

      const sourceMatchedDetails = usageDetails.filter(
        (detail) => Boolean(detail.source) && sourceKeys.has(detail.source)
      );
      const authIndexMatchedDetails =
        sourceMatchedDetails.length === 0 && authIndexKey
          ? usageDetails.filter((detail) => normalizeAuthIndex(detail.auth_index) === authIndexKey)
          : [];

      cache.set(
        getAuthFileStatusBarCacheKey(file),
        calculateStatusBarData(sourceMatchedDetails.length > 0 ? sourceMatchedDetails : authIndexMatchedDetails)
      );
    });

    return cache;
  }, [files, usageDetails]);
}
