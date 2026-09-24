import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'

const isPublicRoute = createRouteMatcher([
  '/sign-in(.*)',
  // Machine-to-machine payload ingestion endpoint. External LoRaWAN devices POST
  // raw binary payloads to /api/payloads and have no Clerk session, so this route
  // must stay public (route matching is by path, not method).
  '/api/payloads(.*)',
  // Devices poll their remote config here with their own Bearer token, which
  // the route checks itself. Exact path only: /api/remote-config (the
  // dashboard's side, which can change a device's config) stays behind Clerk.
  '/api/config',
])

export default clerkMiddleware(
  async (auth, req) => {
    if (!isPublicRoute(req)) {
      await auth.protect()
    }
  },
  {
    signInUrl: '/sign-in',
    signUpUrl: '/sign-in',
  },
)

export const config = {
  matcher: [
    // Skip Next.js internals and all static files (unless found in search params).
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes.
    '/(api|trpc)(.*)',
  ],
}
