import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');

const REFRESH_SECONDS = 15;
// Session logs older than this aren't looked at (the weekly window is 7 days).
const KEEP_MS = 8 * 24 * 3600e3;
const ATTRS = 'standard::name,standard::type,time::modified';
const decoder = new TextDecoder();

// Panel icon colour by whichever of the two limits is closer to running out.
const YELLOW_FROM = 50;
const RED_FROM = 80;
// Usage bar width in CSS px; the fill is a fraction of it.
const BAR_WIDTH = 170;

// Codex writes one JSONL log per session under $CODEX_HOME/sessions/YYYY/MM/DD.
function sessionsDir() {
    const home = GLib.getenv('CODEX_HOME') || GLib.build_filenamev([GLib.get_home_dir(), '.codex']);
    return GLib.build_filenamev([home, 'sessions']);
}

// "6:30 AM" today, otherwise "Saturday 12:00 PM".
function fmtReset(ms) {
    const dt = GLib.DateTime.new_from_unix_local(Math.round(ms / 1000));
    const sameDay = new Date(ms).toDateString() === new Date().toDateString();
    return `Resets ${sameDay ? 'at ' : ''}${dt.format(sameDay ? '%-l:%M %p' : '%A %-l:%M %p')}`;
}

// "Current session" for the 5-hour window, "This week" for 7 days.
function windowTitle(minutes, fallback) {
    if (minutes === 300) return 'Current session';
    if (minutes === 10080) return 'This week';
    if (!minutes) return fallback;
    return minutes % 1440 === 0 ? `${minutes / 1440}-day limit` : `${Math.round(minutes / 60)}-hour limit`;
}

// The newest rate-limit snapshot in a log, as {t, primary, secondary}.
function lastSnapshot(text) {
    let best = null;
    for (const line of text.split('\n')) {
        if (!line.includes('"rate_limits"')) continue;
        let d;
        try {
            d = JSON.parse(line);
        } catch (e) {
            continue;
        }
        const rl = d.payload?.rate_limits;
        const t = Date.parse(d.timestamp);
        if (rl && t && (!best || t >= best.t))
            best = {t, primary: rl.primary ?? null, secondary: rl.secondary ?? null};
    }
    return best;
}

export default class CodexUsage extends Extension {
    enable() {
        // path -> {mtime, snapshot}: a log is only re-read when it changes.
        this._files = new Map();
        this._cancellable = new Gio.Cancellable();

        this._button = new PanelMenu.Button(0.5, this.metadata.name);
        // Just an icon; its colour shows how close the nearer limit is.
        this._icons = Object.fromEntries(['green', 'yellow', 'red'].map(c =>
            [c, Gio.icon_new_for_string(`${this.path}/icons/codex-${c}.svg`)]));
        this._icon = new St.Icon({gicon: this._icons.green, style_class: 'system-status-icon'});
        this._button.add_child(this._icon);

        const menu = this._button.menu;
        menu.box.add_style_class_name('cx-menu');
        this._primaryRow = this._addRow(menu, 'Current session', 'cx-session');
        this._secondaryRow = this._addRow(menu, 'This week', 'cx-week');
        menu.connect('open-state-changed', (m, open) => {
            if (open) this._scan();
        });

        // Left side, right after Claude Usage and before the workspace
        // indicator, or at the end if neither is there.
        const leftBox = Main.panel._leftBox;
        const claude = Main.panel.statusArea['claude-usage@arjun']?.container;
        const ws = Main.panel.statusArea['workspace-indicator']?.container;
        const idx = claude?.get_parent() === leftBox ? leftBox.get_children().indexOf(claude) + 1
            : ws?.get_parent() === leftBox ? leftBox.get_children().indexOf(ws)
                : leftBox.get_n_children();
        Main.panel.addToStatusArea(this.uuid, this._button, idx, 'left');

        this._scan();
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
            this._scan();
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _scan() {
        if (this._busy) return;
        this._busy = true;
        try {
            const cutoff = Date.now() - KEEP_MS;
            await this._scanDir(Gio.File.new_for_path(sessionsDir()), cutoff, 0);
            if (!this._button) return;
            let latest = null;
            for (const f of this._files.values()) {
                if (f.snapshot && (!latest || f.snapshot.t > latest.t)) latest = f.snapshot;
            }
            this._update(latest);
        } catch (e) {
            if (this._button && !e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.error(`${this.uuid}: ${e}`);
        } finally {
            this._busy = false;
        }
    }

    // sessions/YYYY/MM/DD/rollout-*.jsonl
    async _scanDir(dir, cutoff, depth) {
        let en;
        try {
            en = await dir.enumerate_children_async(ATTRS, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, this._cancellable);
        } catch (e) {
            if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) return;
            throw e;
        }
        try {
            for (;;) {
                const infos = await en.next_files_async(100, GLib.PRIORITY_LOW, this._cancellable);
                if (!infos.length) break;
                for (const info of infos) {
                    const child = en.get_child(info);
                    const mtime = info.get_modification_date_time().to_unix() * 1000;
                    if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                        // Not filtered by date: a year folder's time only changes when
                        // a month is added.
                        if (depth < 3) await this._scanDir(child, cutoff, depth + 1);
                    } else if (info.get_name().endsWith('.jsonl') && mtime >= cutoff) {
                        const path = child.get_path();
                        if (this._files.get(path)?.mtime === mtime) continue;
                        const [bytes] = await child.load_contents_async(this._cancellable);
                        this._files.set(path, {mtime, snapshot: lastSnapshot(decoder.decode(bytes))});
                    }
                }
            }
        } finally {
            en.close(null);
        }
    }

    _update(snap) {
        const now = Date.now();
        const limits = [
            [this._primaryRow, snap?.primary, 'Current session'],
            [this._secondaryRow, snap?.secondary, 'This week'],
        ];
        let worst = 0;
        for (const [row, lim, fallback] of limits) {
            row.title.text = windowTitle(lim?.window_minutes, fallback);
            const resetsAt = lim?.resets_at ? lim.resets_at * 1000 : 0;
            if (!lim) {
                this._setRow(row, 0, 'No Codex activity found');
            } else if (resetsAt && resetsAt <= now) {
                // The window has reset since Codex last logged it.
                this._setRow(row, 0, 'Starts with your next message');
            } else {
                const pct = lim.used_percent ?? 0;
                this._setRow(row, pct, resetsAt ? fmtReset(resetsAt) : '');
                worst = Math.max(worst, pct);
            }
        }
        const level = worst >= RED_FROM ? 'red' : worst >= YELLOW_FROM ? 'yellow' : 'green';
        if (this._icon.gicon !== this._icons[level]) this._icon.gicon = this._icons[level];
    }

    // Title and reset time on the left, a bar in the middle, "43% used" right.
    _addRow(menu, title, barClass) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = new St.BoxLayout({style_class: 'cx-row', x_expand: true});
        const text = new St.BoxLayout({vertical: true, style_class: 'cx-text', y_align: Clutter.ActorAlign.CENTER});
        const titleLabel = new St.Label({text: title, style_class: 'cx-title'});
        text.add_child(titleLabel);
        const sub = new St.Label({text: '', style_class: 'cx-sub'});
        text.add_child(sub);
        box.add_child(text);
        const bg = new St.Widget({
            style_class: `cx-bar-bg ${barClass}`,
            style: `width: ${BAR_WIDTH}px;`,
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const fg = new St.Widget({style_class: `cx-bar-fg ${barClass}`});
        bg.add_child(fg);
        box.add_child(bg);
        const pct = new St.Label({text: '', style_class: 'cx-pct', y_align: Clutter.ActorAlign.CENTER});
        box.add_child(pct);
        item.add_child(box);
        menu.addMenuItem(item);
        return {title: titleLabel, sub, fg, pct};
    }

    _setRow(row, percent, resetText) {
        // Fixed widths in CSS, never measured (a closed menu reports the
        // wrong width).
        row.fg.style = `width: ${Math.round(BAR_WIDTH * Math.min(1, percent / 100))}px;`;
        row.pct.text = `${Math.round(percent)}% used`;
        row.sub.text = resetText;
    }

    disable() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        this._cancellable?.cancel();
        this._button?.destroy();
        this._button = this._icon = this._icons = this._primaryRow = this._secondaryRow = null;
        this._files = this._cancellable = null;
        this._busy = false;
    }
}
