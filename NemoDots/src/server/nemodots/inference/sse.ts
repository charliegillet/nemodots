// Incremental Server-Sent Events parser for chat completion streams.
// Feeds arbitrary byte-chunk splits (including splits inside a multi-byte
// character, a line, or a CRLF pair) and yields complete `data:` payloads.

export class SseParser {
  private readonly decoder = new TextDecoder('utf-8');
  private buffer = '';

  /** Feed bytes; returns the data payloads of every event completed by them. */
  push(chunk: Uint8Array): string[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.drain(false);
  }

  /** End of input: flushes a final event that lacked its blank-line terminator. */
  end(): string[] {
    this.buffer += this.decoder.decode();
    return this.drain(true);
  }

  private drain(final: boolean): string[] {
    const out: string[] = [];
    // normalise CRLF / CR to LF; keep a trailing CR for the next chunk
    let text = this.buffer;
    let carry = '';
    if (!final && text.endsWith('\r')) {
      carry = '\r';
      text = text.slice(0, -1);
    }
    text = text.replace(/\r\n|\r/g, '\n');
    let boundary = text.indexOf('\n\n');
    while (boundary !== -1) {
      const data = parseEvent(text.slice(0, boundary));
      if (data !== null) out.push(data);
      text = text.slice(boundary + 2);
      boundary = text.indexOf('\n\n');
    }
    if (final && text.trim().length > 0) {
      const data = parseEvent(text);
      if (data !== null) out.push(data);
      text = '';
    }
    this.buffer = text + carry;
    return out;
  }
}

function parseEvent(block: string): string | null {
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== 'data') continue;
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    data.push(value);
  }
  return data.length === 0 ? null : data.join('\n');
}
