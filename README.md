# Codex Usage for GNOME

A GNOME Shell extension that shows how much of your Codex usage limits you've used, as a single icon in the top bar.

- **Icon colour** shows whichever limit is closer to running out, the 5-hour session or the week: green under 50% used, yellow from 50%, red from 80%
- **Click it** to see the current session and this week as bars, with when each one resets

Usage is read from Codex's local session logs (`~/.codex/sessions`, or `$CODEX_HOME/sessions`). Codex records your actual limit percentages and reset times in those logs as you use it, so the numbers match your account. Nothing is sent anywhere and no login is needed.

The figures are as of your last Codex message. If a window has reset since then, it shows 0% until you use Codex again.

Requires GNOME Shell 50.

## Install

```bash
git clone https://github.com/voidrlm/gnome-codex-usage.git ~/.local/share/gnome-shell/extensions/codex-usage@arjun
```

Log out and back in, then enable it:

```bash
gnome-extensions enable codex-usage@arjun
```

## Update

```bash
git -C ~/.local/share/gnome-shell/extensions/codex-usage@arjun pull
```

Then log out and back in.

Not affiliated with OpenAI.
