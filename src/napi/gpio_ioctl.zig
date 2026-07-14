//! Hand-declared Linux GPIO character-device uAPI v2 structs and ioctl
//! numbers (from <linux/gpio.h>). Hand-declaring avoids adding a
//! `linux/gpio.h` translateC step and keeps the macOS host build clean;
//! this module is imported on every platform but only *used* by the Linux
//! backend and chip enumeration.
const std = @import("std");

pub const GPIO_MAX_NAME_SIZE = 32;
pub const GPIO_V2_LINES_MAX = 64;
pub const GPIO_V2_LINE_NUM_ATTRS_MAX = 10;

pub const gpiochip_info = extern struct {
    name: [GPIO_MAX_NAME_SIZE]u8,
    label: [GPIO_MAX_NAME_SIZE]u8,
    lines: u32,
};

// gpio_v2_line_flag bits.
pub const FLAG_USED: u64 = 1 << 0;
pub const FLAG_ACTIVE_LOW: u64 = 1 << 1;
pub const FLAG_INPUT: u64 = 1 << 2;
pub const FLAG_OUTPUT: u64 = 1 << 3;
pub const FLAG_EDGE_RISING: u64 = 1 << 4;
pub const FLAG_EDGE_FALLING: u64 = 1 << 5;
pub const FLAG_OPEN_DRAIN: u64 = 1 << 6;
pub const FLAG_OPEN_SOURCE: u64 = 1 << 7;
pub const FLAG_BIAS_PULL_UP: u64 = 1 << 8;
pub const FLAG_BIAS_PULL_DOWN: u64 = 1 << 9;
pub const FLAG_BIAS_DISABLED: u64 = 1 << 10;

pub const gpio_v2_line_values = extern struct {
    bits: u64,
    mask: u64,
};

// gpio_v2_line_attr_id
pub const ATTR_ID_FLAGS: u32 = 1;
pub const ATTR_ID_OUTPUT_VALUES: u32 = 2;
pub const ATTR_ID_DEBOUNCE: u32 = 3;

pub const gpio_v2_line_attribute = extern struct {
    id: u32,
    padding: u32,
    value: u64, // union { flags: u64, values: u64, debounce_period_us: u32 }
};

pub const gpio_v2_line_config_attribute = extern struct {
    attr: gpio_v2_line_attribute,
    mask: u64,
};

pub const gpio_v2_line_config = extern struct {
    flags: u64,
    num_attrs: u32,
    padding: [5]u32,
    attrs: [GPIO_V2_LINE_NUM_ATTRS_MAX]gpio_v2_line_config_attribute,
};

pub const gpio_v2_line_request = extern struct {
    offsets: [GPIO_V2_LINES_MAX]u32,
    consumer: [GPIO_MAX_NAME_SIZE]u8,
    config: gpio_v2_line_config,
    num_lines: u32,
    event_buffer_size: u32,
    padding: [5]u32,
    fd: i32,
};

// gpio_v2_line_event_id
pub const EVENT_RISING_EDGE: u32 = 1;
pub const EVENT_FALLING_EDGE: u32 = 2;

pub const gpio_v2_line_event = extern struct {
    timestamp_ns: u64,
    id: u32,
    offset: u32,
    seqno: u32,
    line_seqno: u32,
    padding: [6]u32,
};

// ---------------------------------------------------------------------------
// ioctl number computation: _IOC(dir, type, nr, size)
// ---------------------------------------------------------------------------

const IOC_TYPE: u32 = 0xB4;
const DIR_READ: u32 = 2;
const DIR_WRITE: u32 = 1;

fn ioc(dir: u32, nr: u32, comptime T: type) c_ulong {
    const size: u32 = @sizeOf(T);
    return (dir << 30) | (size << 16) | (IOC_TYPE << 8) | nr;
}

fn iowr(nr: u32, comptime T: type) c_ulong {
    return ioc(DIR_READ | DIR_WRITE, nr, T);
}

fn ior(nr: u32, comptime T: type) c_ulong {
    return ioc(DIR_READ, nr, T);
}

pub const GPIO_GET_CHIPINFO_IOCTL: c_ulong = ior(0x01, gpiochip_info);
pub const GPIO_V2_GET_LINE_IOCTL: c_ulong = iowr(0x07, gpio_v2_line_request);
pub const GPIO_V2_LINE_SET_CONFIG_IOCTL: c_ulong = iowr(0x0D, gpio_v2_line_config);
pub const GPIO_V2_LINE_GET_VALUES_IOCTL: c_ulong = iowr(0x0E, gpio_v2_line_values);
pub const GPIO_V2_LINE_SET_VALUES_IOCTL: c_ulong = iowr(0x0F, gpio_v2_line_values);
