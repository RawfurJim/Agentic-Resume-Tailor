The tool auto-names the sandbox claude-<folder name>. The first run asks you to pick a network policy (Balanced is the recommended one). Anthropic login was done inside the sandbox with /login, which is why you had to log in again just now.

Rebuilding after a Docker reinstall

Docker Sandboxes does not actually need Docker Desktop, so reinstalling Docker will not remove it. If you do lose sbx, this is the whole recipe, run in PowerShell on Windows:

1. Enable the hypervisor feature once, from an elevated PowerShell:
Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All
2. Install the CLI (no admin needed):
winget install -h Docker.sbx
3. Open a terminal in the project folder and start Claude:
cd "C:\Users\Jim\Desktop\Automate_Process\create cv optimised app"
sbx run claude
4. Pick the network policy when prompted, then run /login inside Claude.

Useful day-to-day commands (all run on Windows, not inside the sandbox)

- sbx ls lists sandboxes. sbx stop <name> and sbx rm <name> stop or delete one.
- sbx run --name my-name claude picks a custom name instead of the auto one.
- sbx policy ls, sbx policy allow network <domain> manage which sites Claude can reach.
- sbx secret set github --sandbox <name> -t "$(gh auth token)" lets Claude push to GitHub.
- sbx ports <name> --publish 8000:8000/tcp exposes the FastAPI app to your browser.
- winget upgrade Docker.sbx takes you from v0.39.0 to v0.45.1, as the banner suggests.
