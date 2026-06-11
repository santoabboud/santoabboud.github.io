---
title: "The Frankenscope: a microscopic multi-tool"
description: "A Mitutoyo FS70L4 core on a PI six-axis piezo hexapod, with switchable 1064 nm and 266 nm laser delivery."
category: microscopy
date: 2026-06-10
cover: ./fs70l4-right.jpg
coverAlt: "Mitutoyo FS70L4 microscope body, right side view"
---

This microscope consists of a Mitutoyo FS70L4 as its core, shown here from both sides:

<figure>

![Mitutoyo FS70L4 microscope body, right side view](./fs70l4-right.jpg)

<figcaption>FIG. 01 — FS70L4 core, right side.</figcaption>
</figure>

<figure>

![Mitutoyo FS70L4 microscope body, left side view](./fs70l4-left.jpg)

<figcaption>FIG. 02 — FS70L4 core, left side.</figcaption>
</figure>

It uses a Physik Instrumente six-axis closed-loop piezo hexapod for high-precision sample manipulation, kindly provided by Prof. Dr. Georg Sommerer at the Berliner Hochschule für Technik ([laserscience.berlin](https://laserscience.berlin)).

<figure>

![Physik Instrumente six-axis hexapod stage](./pi-hexapod.jpg)

<figcaption>FIG. 03 — PI six-axis closed-loop piezo hexapod.</figcaption>
</figure>

It is currently equipped with a passively Q-switched 1064 nm DPSS laser, or an optional TEEM Photonics 266 nm sub-nanosecond-pulsewidth deep-UV laser for the most delicate work (teardown documentation coming soon).

<figure>

![TEEM Photonics 266 nm deep UV laser](./teem-266.jpg)

<figcaption>FIG. 04 — TEEM Photonics 266 nm head, &lt;1 ns pulses.</figcaption>
</figure>

<table class="spec-table">
  <tr><td>Core</td><td>Mitutoyo FS70L4</td></tr>
  <tr><td>Stage</td><td>PI six-axis closed-loop piezo hexapod</td></tr>
  <tr><td>Sources</td><td>1064 nm DPSS (pQS) · 266 nm TEEM Photonics, &lt;1 ns</td></tr>
  <tr><td>Spectrometer</td><td>Ocean Optics USB2000+ UV-NIR (LIBS / Raman)</td></tr>
  <tr><td>Illumination</td><td>TILL Photonics Polychrome IV tunable Xe short-arc source</td></tr>
  <tr><td>Control</td><td>LabJack T4</td></tr>
</table>

Additional components include an Ocean Optics USB2000+ UV-NIR spectrometer for LIBS and Raman analysis, a TILL Photonics Polychrome IV tunable-wavelength short-arc xenon light source, and a LabJack T4 for general control. It is also capable of conducting infrared in-situ microscopy — IRIS for short. See Bunnie Huang's work for more about that :-)
