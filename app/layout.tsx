import type { Metadata } from 'next'
import { Poppins } from 'next/font/google'
import { Analytics } from '@vercel/analytics/next'
import { ClerkProvider } from '@clerk/nextjs'
import { Toaster } from 'sonner'
import { EnvironmentProvider } from '@/components/environment-provider'
import './globals.css'

const clerkAppearance = {
  variables: {
    colorPrimary: '#2b2c33',
    colorText: '#1f2024',
    colorTextSecondary: '#6b7280',
    colorBackground: '#ffffff',
    colorInputBackground: '#ffffff',
    colorInputText: '#1f2024',
    borderRadius: '0.75rem',
    fontFamily: 'var(--font-poppins)',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    card: 'rounded-2xl border border-gray-200 shadow-lg bg-white',
    headerTitle: 'font-bold text-gray-900',
    headerSubtitle: 'text-gray-500',
    formFieldLabel: 'font-semibold text-gray-900',
    formFieldInput:
      'rounded-lg border border-gray-300 bg-white placeholder:text-gray-400 focus:border-gray-400 focus:ring-0',
    formButtonPrimary:
      'rounded-lg bg-[#2b2c33] text-white font-semibold normal-case hover:bg-[#1f2024] shadow-none',
    footer: 'bg-gray-50',
    footerAction: 'hidden',
    footerActionText: 'text-gray-500',
    footerActionLink: 'font-bold text-gray-900 hover:text-gray-900',
  },
}

const poppins = Poppins({
  subsets: ['latin'],
  weight: ['100', '200', '300', '400', '500', '600', '700', '800', '900'],
  style: ['normal', 'italic'],
  variable: '--font-poppins',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Onehop Payload Platform',
  description: 'Testing platform for Onehop devices',
  generator: 'v0.app',
  icons: {
    icon: '/energiot_aplicacoes-07.png',
    apple: '/energiot_aplicacoes-07.png',
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <ClerkProvider
      signInUrl="/sign-in"
      signUpUrl="/sign-in"
      appearance={clerkAppearance}
    >
      <html lang="en" className={poppins.variable}>
        <body className="font-sans antialiased bg-background">
          {/* Holds the environment the session operates in, so every page and
              every query below agrees on which payload dataset is active. */}
          <EnvironmentProvider>{children}</EnvironmentProvider>
          <Toaster position="top-right" />
          {process.env.NODE_ENV === 'production' && <Analytics />}
        </body>
      </html>
    </ClerkProvider>
  )
}
