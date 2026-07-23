/**
 * Browser implementation of the FetchJson port (§A.2.1). Kept dumb: HTTP
 * failures throw with a `status` the ref-graph maps to the E_FETCH copy;
 * network/CORS failures bubble as the browser's TypeError. Credentials are
 * never sent — schema hosts are third parties.
 */
import type { FetchJson } from './types';

export const browserFetchJson: FetchJson = async (url) => {
  const response = await fetch(url, {
    headers: { Accept: 'application/schema+json, application/json' },
    redirect: 'follow',
    credentials: 'omit',
  });
  if (!response.ok) {
    throw Object.assign(new Error(`HTTP ${String(response.status)} for ${url}`), {
      status: response.status,
    });
  }
  // response.url is the post-redirect URL (§A.2.1 records it as retrievalUri).
  return { finalUrl: response.url === '' ? url : response.url, text: await response.text() };
};
