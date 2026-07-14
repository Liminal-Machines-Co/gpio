import {
	validateBcm,
	validatePinInputOptions,
	validatePinOutputOptions,
} from "../options.js";
import type {
	Edge,
	IGpio,
	IPin,
	PinDirection,
	PinInputOptions,
	PinOutputOptions,
} from "../types.js";

function edgeMatches(edge: Edge, previous: boolean, next: boolean): boolean {
	if (previous === next) return false;
	if (edge === "both") return true;
	if (edge === "rising") return !previous && next;
	return previous && !next; // "falling"
}

export class MockPin implements IPin {
	public readonly bcm: number;
	public direction: PinDirection | null;

	private _level: boolean;
	private _output: boolean;
	private _edge: Edge | undefined;
	private _onChange: ((value: boolean, timestamp: bigint) => void) | undefined;

	constructor(bcm: number) {
		this.bcm = bcm;
		this.direction = null;
		this._level = false;
		this._output = false;
		this._edge = undefined;
		this._onChange = undefined;
	}

	async setInput(options?: PinInputOptions): Promise<void> {
		validatePinInputOptions(options);
		this._edge = options?.edge;
		this._onChange = options?.onChange;
		this.direction = "in";
	}

	async setOutput(options?: PinOutputOptions): Promise<void> {
		validatePinOutputOptions(options);
		this._edge = undefined;
		this._onChange = undefined;
		this._output = options?.initialValue ?? false;
		this.direction = "out";
	}

	async read(): Promise<boolean> {
		if (this.direction !== "in")
			throw new Error(`Pin ${this.bcm} is not configured as an input`);
		return this._level;
	}

	async write(value: boolean): Promise<void> {
		if (this.direction !== "out")
			throw new Error(`Pin ${this.bcm} is not configured as an output`);
		this._output = value;
	}

	async release(): Promise<void> {
		this.direction = null;
		this._onChange = undefined;
		this._edge = undefined;
	}

	/** Test-only: set the virtual input level, firing `onChange` on a matching edge. */
	driveInput(level: boolean): void {
		const previous = this._level;
		this._level = level;
		if (this.direction === "in" && this._edge && this._onChange) {
			if (edgeMatches(this._edge, previous, level)) {
				this._onChange(level, process.hrtime.bigint());
			}
		}
	}

	/** Test-only: the last value written to this (output) pin. */
	getOutput(): boolean {
		return this._output;
	}
}

export class MockGpio implements IGpio {
	private readonly _pins: Map<number, MockPin>;

	constructor() {
		this._pins = new Map();
	}

	pin(bcm: number): MockPin {
		validateBcm(bcm);
		let pin = this._pins.get(bcm);
		if (!pin) {
			pin = new MockPin(bcm);
			this._pins.set(bcm, pin);
		}
		return pin;
	}

	async release(): Promise<void> {
		for (const pin of this._pins.values()) {
			await pin.release();
		}
	}
}
