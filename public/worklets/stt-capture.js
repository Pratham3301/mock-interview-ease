class PrepwiseSttCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Float32Array(2048);
    this.offset = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;

    let sourceOffset = 0;
    while (sourceOffset < input.length) {
      const length = Math.min(
        input.length - sourceOffset,
        this.chunk.length - this.offset,
      );
      this.chunk.set(input.subarray(sourceOffset, sourceOffset + length), this.offset);
      this.offset += length;
      sourceOffset += length;

      if (this.offset === this.chunk.length) {
        const completed = this.chunk;
        this.port.postMessage(completed, [completed.buffer]);
        this.chunk = new Float32Array(2048);
        this.offset = 0;
      }
    }

    return true;
  }
}

registerProcessor("prepwise-stt-capture", PrepwiseSttCaptureProcessor);
