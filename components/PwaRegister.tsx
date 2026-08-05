'use client';

import { useEffect } from 'react';
import { initPwaInstallCapture, registerSynapseServiceWorker } from '@/lib/pwaInstall';

/** Registers the service worker and captures `beforeinstallprompt` once. */
export default function PwaRegister() {
  useEffect(() => {
    initPwaInstallCapture();
    void registerSynapseServiceWorker();
  }, []);
  return null;
}
