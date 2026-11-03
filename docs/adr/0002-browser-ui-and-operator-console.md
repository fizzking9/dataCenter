# Browser UI and separately authenticated Operator Console

The first release includes a React and TypeScript browser application for Operator, Deployment Administrator, Workspace Administrator, and Consumer workflows. The browser uses authenticated HTTP application APIs over the same governed application modules as the CLI. A separately authenticated Operator Console preserves the boundary between the host-level Operator and platform Users while making post-installation lifecycle work available through both browser and CLI.

Initial Release Bundle verification and installation remain CLI operations because the browser application cannot serve its own initial installation. Operator Console enrollment uses a one-time CLI-issued secret followed by a new Operator credential, MFA, and recovery codes; there is no default browser credential. Every post-installation Operator action retains an equivalent CLI path for automation and recovery when the browser application is unavailable.

## Consequences

- Build the browser application with Vite and serve it from the modular application; server-side rendering and public-site SEO are not requirements.
- Do not duplicate governed business logic in the browser or implement browser workflows by invoking CLI commands.
- Keep Operator sessions separate from platform User sessions and role-based navigation.
- Establish the Simplified Chinese text catalog and shared UI primitives in the first end-to-end Operator Console slice.
- Include real browser workflows in the black-box release certification seam.
