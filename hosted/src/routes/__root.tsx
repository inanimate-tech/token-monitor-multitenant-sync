import { ClerkProvider, UserButton } from '@clerk/tanstack-react-start'
import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router'

const css = `
body{font:15px/1.5 system-ui,sans-serif;max-width:44rem;margin:2rem auto;padding:0 1rem;color:#222}
header,footer{display:flex;justify-content:space-between;align-items:center;gap:1rem}
footer{margin-top:3rem;color:#777;font-size:13px}
code,pre{font:13px ui-monospace,monospace;background:#f3f3f3;border-radius:3px;padding:.1em .3em}
pre{padding:.6em;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:.3em .5em .3em 0}`

export const Route = createRootRoute({
  head: () => ({
    meta: [{ charSet: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1' }, { title: 'Token Monitor Hub' }],
  }),
  component: () => (
    <ClerkProvider>
      <html lang="en">
        <head>
          <HeadContent />
          <style>{css}</style>
        </head>
        <body>
          <header>
            <h1>Token Monitor Hub</h1>
            <UserButton />
          </header>
          <Outlet />
          {/* Every deploy is built from a public commit, so users can read what they run. */}
          <footer>
            <span>
              Running <a href={`${__SOURCE__}/tree/${__COMMIT__}/hosted`}>{__COMMIT__.slice(0, 7)}</a>
            </span>
            <a href={__SOURCE__}>Source</a>
          </footer>
          <Scripts />
        </body>
      </html>
    </ClerkProvider>
  ),
})
