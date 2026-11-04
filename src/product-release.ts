import {
  activeMajorLine,
  findDataProductRelease,
  findDataProductVersion,
  majorLine,
  type DataProductArtifact,
  type DataProductRelease,
  type DataProductVersion,
} from './catalog.js';
import type { Fail } from './errors.js';
import type { QueryTarget } from './product-query-document.js';

/** One Release together with the Version that governs it and the line it serves. */
export interface ResolvedRelease {
  version: DataProductVersion;
  release: DataProductRelease;
  major: number;
}

/** The Version and Release a Release number names, when the Artifact still holds both. */
export function releasedVersion(
  product: DataProductArtifact | undefined,
  releaseNumber: number,
): ResolvedRelease | undefined {
  if (product === undefined) return undefined;
  const release = findDataProductRelease(product, releaseNumber);
  const version = release === undefined
    ? undefined
    : findDataProductVersion(product, release.data_product_version);
  return release === undefined || version === undefined
    ? undefined
    : { version, release, major: version.contract_version.major };
}

/**
 * Resolves the Release a query reads. A named Release is answered exactly, a
 * named major line reads that line's own current Release, and a bare query
 * reads the newest line still serving — never silently the newest data.
 */
export function resolveRelease(
  product: DataProductArtifact,
  target: QueryTarget,
  fail: Fail,
): ResolvedRelease {
  const atRelease = (release: DataProductRelease): ResolvedRelease => {
    const version = findDataProductVersion(product, release.data_product_version);
    if (!version) {
      fail(
        'DATA_PRODUCT_VERSION_NOT_FOUND',
        'The Data Product Version this Release pins is no longer available.',
        'Read the Releases the Data Product publishes.',
      );
    }
    if (version.withdrawn_at !== null) {
      fail(
        'DATA_PRODUCT_VERSION_WITHDRAWN',
        `Data Product Release ${release.release} was withdrawn, so it may not execute a new query.`,
        'Query the newest active major line instead.',
      );
    }
    return { version, release, major: version.contract_version.major };
  };

  if (target.release !== undefined) {
    const release = findDataProductRelease(product, target.release);
    if (!release) {
      fail(
        'DATA_PRODUCT_RELEASE_NOT_FOUND',
        `This Data Product has no Release ${target.release}.`,
        'Read the Releases the Data Product publishes.',
      );
    }
    const resolved = atRelease(release);
    if (target.major !== undefined && resolved.major !== target.major) {
      fail(
        'DATA_PRODUCT_RELEASE_NOT_FOUND',
        `Data Product Release ${target.release} does not belong to Contract major ${target.major}.`,
        'Query the Release under the major line it was published in.',
      );
    }
    return resolved;
  }

  const line = target.major === undefined ? undefined : majorLine(product, target.major);
  if (target.major !== undefined) {
    if (!line) {
      fail(
        'DATA_PRODUCT_MAJOR_NOT_FOUND',
        `This Data Product has no Contract major ${target.major}.`,
        'Read the Releases the Data Product publishes to see its Contract lines.',
      );
    }
    if (line.withdrawn_at !== null) {
      fail(
        'DATA_PRODUCT_MAJOR_WITHDRAWN',
        `Contract major ${line.major} was withdrawn, so it serves no new query.`,
        'Query an active major line or an exact historical Release.',
      );
    }
  }
  const serving = line ?? activeMajorLine(product);
  if (!serving) {
    fail(
      'DATA_PRODUCT_NOT_PUBLISHED',
      'The Data Product has no active Publication to query.',
      'Publish the Data Product again to open a Contract line.',
    );
  }
  const release = findDataProductRelease(product, serving.current_release);
  if (!release) {
    fail('DATA_PRODUCT_RELEASE_NOT_FOUND', `This Data Product has no Release ${serving.current_release}.`);
  }
  return atRelease(release);
}
