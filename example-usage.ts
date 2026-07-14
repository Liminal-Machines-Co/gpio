const chip = new Chip();

// one way of declaring input
const input = chip.pin(15);
input.setInput({ pullup: true });

chip.pin(14).setInput({
  pullup: true,
  onChange: (value: boolean) => {
    console.log(value);
  },
});

const led = chip.pin(13);
led.setOutput();

setInterval(async () => {
  const value: boolean = await input.read();
  await led.write(value);
}, 100);


await chip.pin(14).release();
await chip.release();

