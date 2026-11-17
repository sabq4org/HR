import { useCallback, useEffect, useRef, useState } from 'react';
import { api, useApp } from '../lib';

export function useLoadRaw<T>(url: string | null) {
  const { data } = useApp();
  const [value, setValue] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(url !== null);
    setError('');
    setValue(null);
    if (url === null) return;
    try {
      const result = await api<T>(url);
      if (current === generation.current) setValue(result);
    } catch (e) {
      if (current === generation.current) setError((e as Error).message);
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [url, data.me.id]);
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);
  return { value, loading, error, reload: load };
}
