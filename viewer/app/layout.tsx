import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Oxygen · Organize and review trajectories",
  description: "Organize and review project trajectories locally before deciding what to upload.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
