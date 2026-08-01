import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'PM Synapse',
  description: 'Markdown vaults linked to Project Management',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
