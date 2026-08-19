// Device display corner radius, fetched once and cached. 44pt fallback
// until (or unless) the native getter resolves — right for most modern
// iPhones, and invisible when wrong at rest since the card matches the
// scene background.

import { useEffect, useState } from "react";
import { getScreenCornerRadius } from "../modules/key-input";

let cached: number | null = null;
let pending: Promise<number> | null = null;

export function fetchScreenRadius(): Promise<number> {
  if (cached !== null) return Promise.resolve(cached);
  pending ??= getScreenCornerRadius().then((r) => {
    cached = r > 0 ? r : 44;
    return cached;
  });
  return pending;
}

export function useScreenRadius(): number {
  const [radius, setRadius] = useState(cached ?? 44);
  useEffect(() => {
    fetchScreenRadius().then(setRadius);
  }, []);
  return radius;
}
