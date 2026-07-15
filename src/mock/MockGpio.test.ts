import { expect, test } from "bun:test";
import { MockGpio } from "./MockGpio.js";

test("pin() returns the same cached instance", () => {
	const gpio = new MockGpio();
	const a = gpio.pin(17);
	const b = gpio.pin(17);
	expect(a).toBe(b);
});

test("init() resolves (IGpio parity no-op)", async () => {
	const gpio = new MockGpio();
	await gpio.init();
});

test("setInput then read reflects the driven level", async () => {
	const gpio = new MockGpio();
	const pin = gpio.pin(4);
	await pin.setInput();
	expect(await pin.read()).toBe(false);
	pin.driveInput(true);
	expect(await pin.read()).toBe(true);
});

test("setOutput then write then getOutput", async () => {
	const gpio = new MockGpio();
	const pin = gpio.pin(27);
	await pin.setOutput();
	expect(pin.getOutput()).toBe(false);
	await pin.write(true);
	expect(pin.getOutput()).toBe(true);
});

test("setOutput honors initialValue", async () => {
	const gpio = new MockGpio();
	const pin = gpio.pin(22);
	await pin.setOutput({ initialValue: true });
	expect(pin.getOutput()).toBe(true);
});

test("driveInput fires onChange only on a matching rising edge", async () => {
	const gpio = new MockGpio();
	const pin = gpio.pin(5);
	const events: [boolean, bigint][] = [];
	await pin.setInput({
		edge: "rising",
		onChange: (v, t) => events.push([v, t]),
	});

	pin.driveInput(false); // no change, no event
	expect(events.length).toBe(0);

	pin.driveInput(true); // rising edge, fires
	expect(events.length).toBe(1);
	expect(events[0]?.[0]).toBe(true);
	expect(typeof events[0]?.[1]).toBe("bigint");

	pin.driveInput(false); // falling edge, does not fire (edge: rising)
	expect(events.length).toBe(1);
});

test("driveInput fires onChange on both edges when edge is 'both'", async () => {
	const gpio = new MockGpio();
	const pin = gpio.pin(6);
	const events: boolean[] = [];
	await pin.setInput({ edge: "both", onChange: (v) => events.push(v) });

	pin.driveInput(true);
	pin.driveInput(false);
	pin.driveInput(false); // no change, no event
	expect(events).toEqual([true, false]);
});

test("reconfigure from input to output works", async () => {
	const gpio = new MockGpio();
	const pin = gpio.pin(13);
	await pin.setInput();
	expect(pin.direction).toBe("in");
	await pin.setOutput();
	expect(pin.direction).toBe("out");
	await pin.write(true);
	expect(pin.getOutput()).toBe(true);
});

test("read on an output pin throws", async () => {
	const gpio = new MockGpio();
	const pin = gpio.pin(19);
	await pin.setOutput();
	await expect(pin.read()).rejects.toThrow();
});

test("write on an input pin throws", async () => {
	const gpio = new MockGpio();
	const pin = gpio.pin(26);
	await pin.setInput();
	await expect(pin.write(true)).rejects.toThrow();
});

test("release is idempotent and resets direction", async () => {
	const gpio = new MockGpio();
	const pin = gpio.pin(21);
	await pin.setInput();
	await pin.release();
	expect(pin.direction).toBe(null);
	await pin.release();
	expect(pin.direction).toBe(null);
});

test("gpio.release() releases all cached pins", async () => {
	const gpio = new MockGpio();
	const a = gpio.pin(1);
	const b = gpio.pin(2);
	await a.setInput();
	await b.setOutput();
	await gpio.release();
	expect(a.direction).toBe(null);
	expect(b.direction).toBe(null);
});
