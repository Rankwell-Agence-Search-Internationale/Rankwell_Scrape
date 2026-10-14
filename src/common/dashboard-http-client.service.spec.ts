import axios, { InternalAxiosRequestConfig } from 'axios';
import { DashboardHttpClient } from './dashboard-http-client.service';

describe('DashboardHttpClient authentication', () => {
  const env = (values: Record<string, string>) => ({ get: (k: string) => values[k] });

  function interceptRequest(values: Record<string, string>, url: string) {
    const axiosRef = axios.create();
    new DashboardHttpClient(env(values) as any, { axiosRef } as any);
    const handler = (axiosRef.interceptors.request as any).handlers[0].fulfilled;
    return handler({ url, headers: new axios.AxiosHeaders() } as InternalAxiosRequestConfig);
  }

  const base = { DASHBOARD_BASE_URL: 'https://rankwell.one/api', SCRAPING_RUNS_API_KEY: 'secret' };

  it('sends the shared key on Dashboard requests (writes are rejected with 401 without it)', () => {
    expect(interceptRequest(base, '/netlink/additionalInfo/upsert').headers['X-Api-Key']).toBe('secret');
  });

  it('sends it on absolute URLs to the Dashboard host', () => {
    expect(interceptRequest(base, 'https://rankwell.one/api/backlinks/add').headers['X-Api-Key']).toBe('secret');
  });

  it('never sends it to another host sharing the same axios instance (Paper.club, DomDetailer)', () => {
    expect(interceptRequest(base, 'https://api.paper.club/auth').headers['X-Api-Key']).toBeUndefined();
  });

  it('prefers DASHBOARD_API_KEY when set', () => {
    const headers = interceptRequest({ ...base, DASHBOARD_API_KEY: 'dedicated' }, '/x').headers;
    expect(headers['X-Api-Key']).toBe('dedicated');
  });

  it('sends nothing when no key is configured', () => {
    expect(interceptRequest({ DASHBOARD_BASE_URL: base.DASHBOARD_BASE_URL }, '/x').headers['X-Api-Key']).toBeUndefined();
  });
});
