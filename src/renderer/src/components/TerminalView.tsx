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
        background: '#070a11',
        foreground: '#dce4ee',
        cursor: '#6ee7b7',
        cursorAccent: '#070a11',
        selectionBackground: '#1d4d43',
        black: '#0b1018',
        red: '#fb7185',
        green: '#6ee7b7',
        yellow: '#facc15',
        blue: '#7dd3fc',
        magenta: '#c4b5fd',
        cyan: '#67e8f9',
        white: '#dce4ee',
        brightBlack: '#667487',
        brightRed: '#fda4af',
        brightGreen: '#a7f3d0',
        brightYellow: '#fde68a',
        brightBlue: '#bae6fd',
        brightMagenta: '#ddd6fe',
        brightCyan: '#a5f3fc',
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
    const unsubscribeData = window.foundry.onTerminalData((event) => {
      if (event.id !== snapshot.id) return;
      if (!replayReady) {
        pending.push(event);
        return;
      }
      if (event.sequence <= lastSequence) return;
      terminal.write(event.data);
      lastSequence = event.sequence;
    });
    const unsubscribeExit = window.foundry.onTerminalExit((event) => {
      if (event.id !== snapshot.id) return;
      terminal.write(`\r\n\x1b[90m[process exited ${event.exitCode}]\x1b[0m\r\n`);
    });

    const input = terminal.onData((data) => {
      void window.foundry.writeTerminal(snapshot.id, data).then((result) => {
        if (!result.ok) terminal.write(`\r\n\x1b[31m[input failed: ${result.error}]\x1b[0m\r\n`);
      });
    });

    const fitAndResize = (): void => {
      if (host.clientWidth <= 0 || host.clientHeight <= 0) return;
      try {
        fit.fit();
        void window.foundry.resizeTerminal(snapshot.id, terminal.cols, terminal.rows);
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

    void window.foundry.getTerminalReplay(snapshot.id).then((replay) => {
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
