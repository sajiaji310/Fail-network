import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'NetScope · 网络故障智能研判',
  description: '把一堆告警变成一个带证据的结论',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-bg text-text">{children}</body>
    </html>
  );
}
