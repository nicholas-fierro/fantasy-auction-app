import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { QueryProvider } from "@/components/providers/query-provider";
import { Toaster } from "@/components/ui/sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Fantasy Football Draft Helper",
  description: "Manage your fantasy football auction draft",
  manifest: "/manifest.webmanifest",
  // Only the apple icon here — src/app/favicon.ico already emits rel="icon", and
  // adding icons.icon would emit a second, competing one. The install icon comes
  // from the manifest, not from a <link>.
  icons: { apple: "/apple-touch-icon.png" },
  // Standalone launch, home-screen label, and status bar on iOS come from these
  // meta tags. statusBarStyle stays "default" (opaque strip, web view starts
  // below it) — "black-translucent" draws under the status bar but does not
  // grow 100dvh to match, so every full-height layout has to compensate.
  appleWebApp: {
    capable: true,
    title: "Draft Helper",
    statusBarStyle: "default",
  },
  // Next renders appleWebApp.capable as the standardized `mobile-web-app-capable`
  // only; iOS before 17.4 reads just the apple-prefixed name, so emit it too.
  other: { "apple-mobile-web-app-capable": "yes" },
};

// No maximumScale/userScalable — pinch zoom stays available.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <QueryProvider>
          {children}
          <Toaster />
        </QueryProvider>
      </body>
    </html>
  );
}
