import type { Metadata } from 'next';
import './globals.css';
import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github-dark.css';
import PwaRegister from '@/components/PwaRegister';

export const metadata: Metadata = {
  title: 'PM Synapse',
  description: 'Markdown vaults linked to Project Management',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'Synapse',
    statusBarStyle: 'black-translucent',
  },
  icons: {
    icon: [
      {
        url: '/favicon-light.png',
        type: 'image/png',
        media: '(prefers-color-scheme: light)',
      },
      {
        url: '/favicon-dark.png',
        type: 'image/png',
        media: '(prefers-color-scheme: dark)',
      },
      {
        url: '/favicon.png',
        type: 'image/png',
      },
      {
        url: '/icon-192.png',
        type: 'image/png',
        sizes: '192x192',
      },
      {
        url: '/icon-512.png',
        type: 'image/png',
        sizes: '512x512',
      },
    ],
    apple: [
      {
        url: '/apple-touch-icon-light.png',
        media: '(prefers-color-scheme: light)',
      },
      {
        url: '/apple-touch-icon-dark.png',
        media: '(prefers-color-scheme: dark)',
      },
    ],
  },
};

export const viewport = {
  themeColor: '#0a0e13',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen antialiased">
        <PwaRegister />
        {children}
      </body>
    </html>
  );
}
