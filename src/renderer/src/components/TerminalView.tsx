import { useEffect, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import type { TerminalDataEvent, TerminalSnapshot } from '../../../shared/contracts';

export function TerminalView({ terminal: snapshot }: { terminal: TerminalSnapshot }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const terminal = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      cursorStyle: 'bar',
      convertEol: false,
      fontFamily: '"SFMono-Regular", "JetBrains Mono", Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.25,
      scrollback: 10_000,
      theme: {
        background: '#18181b',
        foreground: '#fafafa',
        cursor: '#fafafa',
        cursorAccent: '#18181b',
        selectionBackground: '#3f3f46',
        black: '#27272a',
        red: '#fb7185',
        green: '#86efac',
        yellow: '#facc15',
        blue: '#7dd3fc',
        magenta: '#c4b5fd',
        cyan: '#93c5fd',
        white: '#e4e4e7',
        brightBlack: '#71717a',
        brightRed: '#fda4af',
        brightGreen: '#bbf7d0',
        brightYellow: '#fde68a',
        brightBlue: '#bae6fd',
        brightMagenta: '#ddd6fe',
        brightCyan: '#bfdbfe',
        brightWhite: '#ffffff'
      }
    });
    const fit = new FitAddon();
    const unicode = new Unicode11Addon();
    terminal.loadAddon(fit);
    terminal.loadAddon(unicode);
    terminal.unicode.activeVersion = '11';
    terminal.open(host);

    let webgl: WebglAddon | null = null;
    try {
      webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl?.dispose();
        webgl = null;
      });
      terminal.loadAddon(webgl);
    } catch {
      webgl?.dispose();
      webgl = null;
    }

    let replayReady = false;
    let lastSequence = 0;
    const pending: TerminalDataEvent[] = [];
    const unsubscribeData = window.relay.onTerminalData((event) => {
      if (event.id !== snapshot.id) return;
      if (!replayReady) {
        pending.push(event);
        return;
      }
      if (event.sequence <= lastSequence) return;
      terminal.write(event.data);
      lastSequence = event.sequence;
    });
    const unsubscribeExit = window.relay.onTerminalExit((event) => {
      if (event.id !== snapshot.id) return;
      terminal.write(`\r\n\x1b[90m[process exited ${event.exitCode}]\x1b[0m\r\n`);
    });

    const input = terminal.onData((data) => {
      void window.relay.writeTerminal(snapshot.id, data).then((result) => {
        if (!result.ok) terminal.write(`\r\n\x1b[31m[input failed: ${result.error}]\x1b[0m\r\n`);
      });
    });

    const fitAndResize = (): void => {
      if (host.clientWidth <= 0 || host.clientHeight <= 0) return;
      try {
        fit.fit();
        void window.relay.resizeTerminal(snapshot.id, terminal.cols, terminal.rows);
      } catch {
        // The host may be between layout passes.
      }
    };
    const resizeObserver = new ResizeObserver(fitAndResize);
    resizeObserver.observe(host);
    requestAnimationFrame(() => {
      fitAndResize();
      terminal.focus();
    });

    void window.relay.getTerminalReplay(snapshot.id).then((replay) => {
      terminal.write(replay.data);
      lastSequence = replay.lastSequence;
      replayReady = true;
      for (const event of pending.sort((left, right) => left.sequence - right.sequence)) {
        if (event.sequence <= lastSequence) continue;
        terminal.write(event.data);
        lastSequence = event.sequence;
      }
      pending.length = 0;
      if (snapshot.status === 'exited') {
        terminal.write(`\r\n\x1b[90m[process exited ${snapshot.exitCode ?? 'unknown'}]\x1b[0m\r\n`);
      }
      fitAndResize();
    }).catch((error) => {
      replayReady = true;
      terminal.write(`\r\n\x1b[31m[replay unavailable: ${String(error)}]\x1b[0m\r\n`);
    });

    return () => {
      resizeObserver.disconnect();
      unsubscribeData();
      unsubscribeExit();
      input.dispose();
      webgl?.dispose();
      terminal.dispose();
    };
  }, [snapshot.id]);

  return <div ref={hostRef} className="terminal-host" aria-label={`${snapshot.name} terminal`} />;
}
