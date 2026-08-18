import { Toaster } from "sonner";
import type { Metadata } from "next";
import localFont from "next/font/local";

import "./globals.css";

const monaSans = localFont({
  src: "./fonts/MonaSans.woff2",
  variable: "--font-mona-sans",
  display: "swap",
  style: "normal",
  weight: "200 900",
});

export const metadata: Metadata = {
  title: "PrepWise",
  description: "An AI-powered platform for preparing for mock interviews",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${monaSans.className} antialiased pattern`}>
        {children}

        <Toaster />
      </body>
    </html>
  );
}
