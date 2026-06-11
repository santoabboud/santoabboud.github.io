---
title: "Ocean Optics USB2000 firmware update"
description: "A compilation of info about Ocean Optics USB2000 spectrometers, and a board-level guide to reflashing their firmware EEPROM."
category: spectroscopy
date: 2026-06-10
---

<!-- NOTE: images below are temporarily hotlinked to GitHub's asset CDN.
     Replace with local files per IMAGES_TODO.md in this folder. -->

<div class="callout"><span class="lbl">DISCLAIMER</span>
I am not responsible for any damages caused by using this procedure. You can use it at your own risk.</div>

## Introduction

The Ocean Optics USB2000 is a compact crossed Czerny-Turner type spectrometer with SMA905 fiber-optic input and a 10-pin IO header (the connector is a Samtec IPS1-105-01-S-D-RA, available from Mouser).

<figure>

![Schematic layout of the USB2000 optical bench](https://github.com/user-attachments/assets/0aeec642-dd8b-4bae-9265-e9d3c2807801)

<figcaption>FIG. 01 — USB2000 optical-bench layout.</figcaption>
</figure>

…and the real thing:

<figure>

![USB2000 with cover removed, optical bench visible](https://github.com/user-attachments/assets/cae66f44-db83-419b-b6c7-e5cece646956)

<figcaption>FIG. 02 — The real thing.</figcaption>
</figure>

While it is rare to find units that are configured to measure spectra beyond 880 nm…

## Directly flashing the EEPROM that stores the firmware

You will need:

- Arduino Uno
- Arduino (wireless) SD shield
- 4× mini probing grabbers
- SD card
- Jumper cables

### Opening up the USB2000

Use a razor blade or a suitable alternative…

<figure>

![USB2000 case corner with the screw exposed](https://github.com/user-attachments/assets/3b1642ff-d517-4365-a463-14678c337c1f)

<figcaption>FIG. 03 — Corner screws, sticker removed.</figcaption>
</figure>

**If you have located all four corner screws, unscrew them.**

<figure>

![USB2000 lid with sticker partially peeled](https://github.com/user-attachments/assets/3eaafccb-7831-45f8-96a5-7ccb042882c5)

<figcaption>FIG. 04 — Sticker over the lid screws.</figcaption>
</figure>

Once the screws are removed, pull the lid up…

<figure>

![USB2000 opened, PCB visible](https://github.com/user-attachments/assets/05b8056c-d707-40d2-ad41-744653f47a93)

<figcaption>FIG. 05 — Lid off, board exposed.</figcaption>
</figure>

### Connecting to the EEPROM

First locate the EEPROM on which the firmware is stored…

<figure>

![USB2000 PCB with the firmware EEPROM location indicated](https://github.com/user-attachments/assets/c345c3fb-77dd-4e8d-9fa6-5eef5105bf1d)

<figcaption>FIG. 06 — Locating the 24LC256.</figcaption>
</figure>

Close-up view:

<figure>

![Close-up of the 24LC256 EEPROM](https://github.com/user-attachments/assets/20154351-0ffe-4b8b-8571-499dc61cc347)

<figcaption>FIG. 07 — EEPROM close-up.</figcaption>
</figure>

Now use mini probing grabbers to connect to the following pins:

- VCC to a +3.3 V or +5 V supply
- VSS to GND
- SDA to Analog Pin 4
- SCL to Analog Pin 5

<figure>

![24LC256 pinout diagram](https://github.com/user-attachments/assets/a3878a98-8b6f-4a4a-af3b-ceceab6394df)

<figcaption>FIG. 08 — 24LC256 pinout.</figcaption>
</figure>

It should look something like this:

<figure>

![Probing grabbers attached to the EEPROM](https://github.com/user-attachments/assets/eb921588-6b9b-4bfe-9254-a1c86b63da56)

<figcaption>FIG. 09 — Grabbers in place.</figcaption>
</figure>

## Flashing the EEPROM

Load the firmware file `usb2000v2510.iic` onto the SD card. Now put the SD card into the Arduino SD shield. Use the Arduino to run the following code:

```cpp
#include <SPI.h>
#include <SD.h>
#include <Wire.h>

#define PROG_FNAME      "USB200~1.iic"
#define PROG_VERIFY     0

#define PIN_SDCARD_CS   4

#define UART_BAUD       9600

#define EEPROM_I2C_ADDR 0x51
#define EEPROM_BASE     0

Sd2Card card;

byte eeprom_read(int i2c_addr, unsigned int dev_addr)
{
    byte data = 0xff;

    Wire.beginTransmission(i2c_addr);
    Wire.write((int)(dev_addr >> 8));
    Wire.write((int)(dev_addr & 0xff));
    Wire.endTransmission();
    Wire.requestFrom(i2c_addr, 1);

    if (Wire.available())
        data = Wire.read();

    return data;
}

int eeprom_write(int i2c_addr, unsigned long dev_addr, byte data)
{
    Wire.beginTransmission(i2c_addr);
    Wire.write((int)(dev_addr >> 8));
    Wire.write((int)(dev_addr & 0xFF));
    Wire.write(data);
    Wire.endTransmission();

    return 0;
}

int prog_eeprom(const char *fname)
{
    char buf[64];
    uint8_t e_byte;
    uint8_t f_byte;
    File f;
    char c;

    Serial.println("Opening firmware file");

    f = SD.open(fname, FILE_READ);
    if (!f) {
        Serial.println("Could not open file");
        return -1;
    }

    Serial.print("Will reprogram EEPROM. Continue? [y/N]");
    while (!Serial.available()) {
        yield();
    }
    c = Serial.read();
    if (c != 'y') {
        Serial.println("Aborting");
        return -1;
    }

    Serial.println("");
    Serial.print("Programming EEPROM (");
    Serial.print(f.size());
    Serial.print(" bytes)\n");

    for (unsigned long i = 0; i < f.size(); i++) {
        f_byte = f.read();
        eeprom_write(EEPROM_I2C_ADDR, EEPROM_BASE + i, f_byte);
        delay(10); /* usec */
#if PROG_VERIFY
        e_byte = eeprom_read(EEPROM_I2C_ADDR, EEPROM_BASE + i);
        if (f_byte != e_byte) {
            sprintf(buf, "Could not verify byte at %08x: 0x%x (should be 0x%x)", i, f_byte, e_byte);
            Serial.println(buf);
            return -1;
        }
#endif /* PROG_VERIFY */
    }
    f.close();

    return 0;
}

void setup()
{
    int rc;

    Wire.begin();

    Serial.begin(UART_BAUD);
    while (!Serial)
        ; /* wait for serial monitor */

    Serial.println("Initializing SD card");

    if (!SD.begin(PIN_SDCARD_CS)) {
        Serial.println("Could not initialize SD card");
        while (1);
    }

    Serial.println("Programming EEPROM");
    rc = prog_eeprom(PROG_FNAME);
    if (rc) {
        Serial.println("Programming failed");
        while (1);
    }
    Serial.println("Programming complete");
}

void loop()
{
    /* stub */
}
```

After this, your USB2000 spectrometer should have been flashed… Good luck and have fun!
