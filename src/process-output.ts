/**
 * Bounded process-output retention: code-point helpers, head/tail buffer,
 * truncation, and the monotonic cursor-indexed OutputLog.
 *
 * Pure retention/cursor semantics. Process ownership, child lifecycle, and
 * recovery stay in process-sessions.ts, which re-exports these symbols so
 * the existing `./process-sessions.js` import surface is unchanged.
 */

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function sliceCodePoints(value: string, start: number, end?: number): string {
  return Array.from(value).slice(start, end).join("");
}

function takeHead(value: string, count: number): string {
  if (count <= 0) return "";
  return sliceCodePoints(value, 0, count);
}

function takeTail(value: string, count: number): string {
  if (count <= 0) return "";
  const characters = Array.from(value);
  return characters.slice(Math.max(0, characters.length - count)).join("");
}

function splitBudget(maxCharacters: number): { head: number; tail: number } {
  return {
    head: Math.ceil(maxCharacters / 2),
    tail: Math.floor(maxCharacters / 2),
  };
}

function formatHeadTail(head: string, tail: string, omittedCharacters: number): string {
  if (omittedCharacters <= 0) return head + tail;
  return `${head}\n... output truncated (${omittedCharacters} characters omitted) ...\n${tail}`;
}

export class HeadTailBuffer {
  private head = "";
  private tail = "";
  private totalCharacters = 0;

  constructor(private readonly maxCharacters: number) {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
      throw new Error("Head/tail buffer limit must be a positive integer.");
    }
  }

  append(output: string): void {
    if (!output) return;

    const previousTotal = this.totalCharacters;
    this.totalCharacters += codePointLength(output);

    if (this.totalCharacters <= this.maxCharacters) {
      this.head += output;
      return;
    }

    const budget = splitBudget(this.maxCharacters);
    if (previousTotal <= this.maxCharacters) {
      const fullOutput = this.head + output;
      this.head = takeHead(fullOutput, budget.head);
      this.tail = takeTail(fullOutput, budget.tail);
      return;
    }

    this.tail = takeTail(this.tail + output, budget.tail);
  }

  hasOutput(): boolean {
    return this.totalCharacters > 0;
  }

  drain(maxCharacters: number): { output: string; truncated: boolean } {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
      throw new Error("Output limit must be a positive integer.");
    }

    const omittedByBuffer = Math.max(
      0,
      this.totalCharacters - codePointLength(this.head) - codePointLength(this.tail),
    );
    const retained = formatHeadTail(this.head, this.tail, omittedByBuffer);
    const output = truncateOutput(retained, maxCharacters);
    const truncated = omittedByBuffer > 0 || output.truncated;

    this.head = "";
    this.tail = "";
    this.totalCharacters = 0;

    return { output: output.output, truncated };
  }
}

function truncateOutput(output: string, maxCharacters: number): { output: string; truncated: boolean } {
  const outputCharacters = codePointLength(output);
  if (outputCharacters <= maxCharacters) return { output, truncated: false };

  const marker = "\n... output truncated ...\n";
  const markerCharacters = codePointLength(marker);
  const available = Math.max(0, maxCharacters - markerCharacters);
  const budget = splitBudget(available);
  return {
    output: takeHead(output, budget.head) + marker + takeTail(output, budget.tail),
    truncated: true,
  };
}

/**
 * Bounded, monotonically indexed output log (P0: nondestructive polling).
 *
 * Appends are assigned consecutive character cursors. Reads NEVER destroy
 * data: a read at a given cursor returns the same bytes until the chunk is
 * evicted by the retention bound. This is what makes poll_process retry-safe
 * (a lost response can be re-read at the same cursor) and allows multiple
 * observers to follow one process independently.
 */
export class OutputLog {
  /** Chunks of retained output; each carries its start cursor. */
  private chunks: Array<{ startCursor: number; text: string }> = [];
  private retainedCharacters = 0;
  private writeCursor = 0;

  constructor(private readonly maxCharacters: number) {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
      throw new Error("Output log limit must be a positive integer.");
    }
  }

  append(output: string): number {
    if (!output) return this.writeCursor;
    const incomingLength = codePointLength(output);
    if (incomingLength > this.maxCharacters) {
      // A single write larger than the entire retention bound is kept as its
      // bounded tail; the configured limit is a strict memory bound, never a
      // hint. Cursors stay monotonic: the evicted head is simply
      // unaddressable, and readers learn that via cursorLapsed.
      const kept = takeTail(output, this.maxCharacters);
      this.chunks = [{ startCursor: this.writeCursor + incomingLength - this.maxCharacters, text: kept }];
      this.retainedCharacters = codePointLength(kept);
      this.writeCursor += incomingLength;
      return this.writeCursor;
    }
    this.chunks.push({ startCursor: this.writeCursor, text: output });
    this.retainedCharacters += incomingLength;
    this.writeCursor += incomingLength;
    this.evict();
    return this.writeCursor;
  }

  get cursor(): number {
    return this.writeCursor;
  }

  hasOutput(): boolean {
    return this.retainedCharacters > 0;
  }

  /** Oldest cursor still retained; earlier ranges were evicted. */
  get oldestCursor(): number {
    return this.chunks.length > 0 ? this.chunks[0].startCursor : this.writeCursor;
  }

  /**
   * Read up to maxCharacters starting strictly after afterCursor. Returns
   * cursorLapsed=true when the requested range was already evicted (the
   * caller fell behind retention and MUST be told, never silently given a
   * hole).
   */
  read(afterCursor: number, maxCharacters: number): {
    output: string;
    nextCursor: number;
    oldestAvailableCursor: number;
    cursorLapsed: boolean;
    truncated: boolean;
  } {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
      throw new Error("Output limit must be a positive integer.");
    }
    if (!Number.isInteger(afterCursor) || afterCursor < 0) {
      throw new Error("afterCursor must be a non-negative integer.");
    }

    const oldestAvailableCursor = this.oldestCursor;
    const cursorLapsed = afterCursor < oldestAvailableCursor;
    const effectiveStart = Math.max(afterCursor, oldestAvailableCursor);

    // Assemble at most maxCharacters of retained text from effectiveStart
    // onward. A small cursor read never materializes the whole retained log;
    // the loop stops once the caller's budget is filled.
    let assembled = "";
    let assembledLength = 0;
    for (const chunk of this.chunks) {
      if (assembledLength >= maxCharacters) break;
      const chunkEnd = chunk.startCursor + codePointLength(chunk.text);
      if (chunkEnd <= effectiveStart) continue;
      const offset = Math.max(0, effectiveStart - chunk.startCursor);
      const piece = sliceCodePoints(chunk.text, offset, offset + (maxCharacters - assembledLength));
      assembled += piece;
      assembledLength += codePointLength(piece);
    }

    const availableCharacters = this.writeCursor - effectiveStart;
    const truncatedByLimit = availableCharacters > assembledLength;
    const output = truncateOutput(assembled, maxCharacters);

    return {
      output: output.output,
      nextCursor: effectiveStart + assembledLength,
      oldestAvailableCursor,
      cursorLapsed,
      truncated: output.truncated || truncatedByLimit || cursorLapsed,
    };
  }

  private evict(): void {
    while (this.retainedCharacters > this.maxCharacters && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!;
      this.retainedCharacters -= codePointLength(dropped.text);
    }
    // A single oversized chunk is retained as-is; reads bound what they return.
  }
}
