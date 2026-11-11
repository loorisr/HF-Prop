/*
 * ohp.c - thin, allocation-free driver around the ITU-R P.533-14 engine
 *         (P533() + P372 noise) for use from JavaScript / WebAssembly.
 *
 * Why not ITURHFProp's main()? It re-reads 11 MB of coefficients, parses a
 * text config and writes a text report on every invocation. Here the month's
 * data is loaded once and P533() is called directly, so one call costs only
 * the propagation maths itself.
 *
 * All exported functions use plain numbers; results are written to a static
 * double array (ohp_result) that JS reads through the module memory.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <stdint.h>

#include "Common.h"
#include "P533.h"

#define EXPORT(name) __attribute__((export_name(#name)))

#define NHRS 24
#define NLNG 241
#define NLAT 121
#define NSSN 2
#define NION (NHRS * NLNG * NLAT * NSSN)

static struct PathData path;
static int initialised = 0;
static int month_loaded = -1;

/* Receive buffer for the packed ionosphere file (see scripts/pack_data.py). */
static uint8_t *ion_buf = NULL;

/* Output of the last ohp_run(). Layout documented in ohp_run(). */
static double result[24];

/* ------------------------------------------------------------------ */
/* Antennas: analytic patterns over average ground                    */
/* ------------------------------------------------------------------ */

#define ANT_ISO 0
#define ANT_VERTICAL 1
#define ANT_DIPOLE 2
#define ANT_YAGI3 3
#define ANT_NVIS 4 /* low dipole, ~0.15 lambda: same model, low height */

#define MAXAFREQ 16
static double ant_freqs[MAXAFREQ];
static int ant_nfreq = 0;

struct AntSpec {
	int type;
	double height; /* m above ground */
	double heading; /* deg true of main lobe / broadside, <0 = aim at the other station */
	double extra; /* dB added (losses / gains) */
};
static struct AntSpec ant_spec[2];
static int ant_dirty = 1;

/* Complex helpers (avoid depending on <complex.h> in wasi-libc). */
typedef struct { double re, im; } cplx;
static cplx c_mk(double r, double i) { cplx c = { r, i }; return c; }
static cplx c_add(cplx a, cplx b) { return c_mk(a.re + b.re, a.im + b.im); }
static cplx c_sub(cplx a, cplx b) { return c_mk(a.re - b.re, a.im - b.im); }
static cplx c_mul(cplx a, cplx b) { return c_mk(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re); }
static cplx c_div(cplx a, cplx b) {
	double d = b.re * b.re + b.im * b.im;
	return c_mk((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d);
}
static cplx c_sqrt(cplx a) {
	double m = sqrt(sqrt(a.re * a.re + a.im * a.im));
	double t = 0.5 * atan2(a.im, a.re);
	return c_mk(m * cos(t), m * sin(t));
}
static double c_abs(cplx a) { return sqrt(a.re * a.re + a.im * a.im); }

/* Fresnel reflection coefficients, average ground (er=13, sigma=5 mS/m). */
static void ground_gamma(double psi, double fmhz, cplx *gh, cplx *gv) {
	double lambda = 299.792458 / fmhz;
	cplx ec = c_mk(13.0, -60.0 * 0.005 * lambda);
	double s = sin(psi), c = cos(psi);
	cplx root = c_sqrt(c_sub(ec, c_mk(c * c, 0)));
	cplx S = c_mk(s, 0);
	*gh = c_div(c_sub(S, root), c_add(S, root));
	cplx ecs = c_mul(ec, S);
	*gv = c_div(c_sub(ecs, root), c_add(ecs, root));
}

/* |1 + G exp(-j 2 k h sin psi)| */
static double ground_factor(cplx g, double psi, double h, double fmhz) {
	double k = 2.0 * PI * fmhz / 299.792458;
	double ph = -2.0 * k * h * sin(psi);
	cplx e = c_mk(cos(ph), sin(ph));
	return c_abs(c_add(c_mk(1, 0), c_mul(g, e)));
}

/* Gain in dBi at elevation psi (rad), azimuth phi relative to main lobe (rad). */
static double ant_gain(const struct AntSpec *a, double psi, double phi, double fmhz) {
	cplx gh, gv;
	double g;
	if (a->type == ANT_ISO) return a->extra;
	if (psi < 0.0005) psi = 0.0005;
	ground_gamma(psi, fmhz, &gh, &gv);

	if (a->type == ANT_VERTICAL) {
		/* Ground-mounted quarter-wave monopole with radials. */
		double c = cos(psi);
		double el = (c > 1e-6) ? cos(0.5 * PI * sin(psi)) / c : 0.0;
		double gf = c_abs(c_add(c_mk(1, 0), gv)) / 2.0; /* 1 for perfect ground */
		double p = el * el * gf * gf;
		g = 2.15 + 3.0 + 10.0 * log10(p + 1e-12) - 1.5; /* -1.5 dB radial/ground loss */
	} else if (a->type == ANT_DIPOLE || a->type == ANT_NVIS) {
		/* Half-wave horizontal dipole resonant on each band, broadside = heading. */
		double ct = cos(psi) * sin(phi); /* cos of angle to wire axis */
		double st = sqrt(1.0 - ct * ct);
		double el = (st > 1e-6) ? cos(0.5 * PI * ct) / st : 0.0;
		double gf = ground_factor(gh, psi, a->height, fmhz);
		double p = el * el * gf * gf;
		g = 2.15 + 10.0 * log10(p + 1e-12) - 0.5;
	} else { /* ANT_YAGI3 */
		/* 3-element Yagi: ~7.5 dBi free space, F/B ~20 dB. */
		double ct = cos(psi) * cos(phi);
		double u = 0.5 * (1.0 + ct);
		double p = pow(u, 4.6) + 0.01;
		double gf = ground_factor(gh, psi, a->height, fmhz);
		g = 7.5 + 10.0 * log10(p * gf * gf + 1e-12);
	}
	g += a->extra;
	if (g < -30.0) g = -30.0;
	return g;
}

/*
 * Fill an antenna pattern. Azimuth index = true bearing in degrees.
 * A "follow" antenna (heading < 0) always points at the far end, so its gain
 * toward the other station depends only on elevation: we store the boresight
 * elevation profile at every azimuth and never need to re-aim it.
 */
static void fill_antenna(struct Antenna *A, const struct AntSpec *a) {
	int f, az, el;
	double prof[91];
	for (f = 0; f < A->freqn; f++) {
		double fmhz = A->freqs[f];
		if (a->type == ANT_ISO || a->heading < 0.0) {
			for (el = 0; el < 91; el++) prof[el] = ant_gain(a, el * D2R, 0.0, fmhz);
			for (az = 0; az < 360; az++) memcpy(A->pattern[f][az], prof, sizeof(prof));
		} else {
			for (az = 0; az < 360; az++) {
				double phi = ((double)az - a->heading) * D2R;
				for (el = 0; el < 91; el++) A->pattern[f][az][el] = ant_gain(a, el * D2R, phi, fmhz);
			}
		}
	}
}

/* ------------------------------------------------------------------ */
/* Exports                                                            */
/* ------------------------------------------------------------------ */

EXPORT(ohp_malloc) void *ohp_malloc(int n) { return malloc((size_t)n); }
EXPORT(ohp_free) void ohp_free(void *p) { free(p); }
EXPORT(ohp_result_ptr) double *ohp_result_ptr(void) { return result; }

/* Allocate path memory and read the P.1239 decile table from /data/. */
EXPORT(ohp_init) int ohp_init(void) {
	int rv;
	if (initialised) return 0;
	memset(&path, 0, sizeof(path));
	rv = AllocatePathMemory(&path);
	if (rv != RTN_ALLOCATEP533OK) return -rv;
	rv = ReadP1239(&path, "/data/");
	if (rv != RTN_READP1239OK) return -rv;

	strcpy(path.name, "ohp");
	strcpy(path.txname, "TX");
	strcpy(path.rxname, "RX");
	path.year = 2026;
	path.SSN = 100;
	path.Modulation = ANALOG;
	path.SorL = SHORTPATH;
	path.BW = 3000.0;
	path.txpower = -10.0;
	path.SNRr = 10.0;
	path.SNRXXp = 90;
	path.noiseP.ManMadeNoise = RESIDENTIAL;
	path.SIRr = 0.0; path.A = 0.0; path.TW = 0.0; path.FW = 0.0; path.T0 = 0.0; path.F0 = 0.0;

	for (rv = 0; rv < 2; rv++) {
		ant_spec[rv].type = ANT_ISO;
		ant_spec[rv].height = 10.0;
		ant_spec[rv].heading = -1.0;
		ant_spec[rv].extra = 0.0;
	}
	ant_freqs[0] = 14.0;
	ant_nfreq = 1;
	AllocateAntennaMemory(&path.A_tx, MAXAFREQ, 360, 91);
	AllocateAntennaMemory(&path.A_rx, MAXAFREQ, 360, 91);
	path.A_tx.freqn = 1; path.A_rx.freqn = 1;
	initialised = 1;
	return 0;
}

/* Buffer that JS fills with the packed ionosphere data for one month. */
EXPORT(ohp_ion_buffer) uint8_t *ohp_ion_buffer(void) {
	if (!ion_buf) ion_buf = (uint8_t *)malloc((size_t)NION * 2 * 2);
	return ion_buf;
}

/*
 * Decode the packed ionosphere data and read the month's noise coefficients.
 * Packed format (little endian), for foF2 then M3kF2, each NION values in the
 * original file order (ssn, lng, lat, hour):
 *   q = round(v * scale) as uint16, delta-coded along the hour axis
 *   (mod 65536), stored as two byte planes (all low bytes, then all high).
 * scale = 3000 for foF2, 15000 for M(3000)F2.
 */
EXPORT(ohp_load_month) int ohp_load_month(int month /* 1..12 */) {
	int rv, a, i, j, k, m;
	if (!initialised || !ion_buf) return -1;
	for (a = 0; a < 2; a++) {
		const uint8_t *lo = ion_buf + (size_t)a * NION * 2;
		const uint8_t *hi = lo + NION;
		float ****arr = (a == 0) ? path.foF2 : path.M3kF2;
		float inv = (a == 0) ? (1.0f / 3000.0f) : (1.0f / 15000.0f);
		size_t idx = 0;
		for (m = 0; m < NSSN; m++)
			for (j = 0; j < NLNG; j++)
				for (k = 0; k < NLAT; k++) {
					uint16_t acc = 0;
					for (i = 0; i < NHRS; i++, idx++) {
						acc = (uint16_t)(acc + (uint16_t)(lo[idx] | (hi[idx] << 8)));
						arr[i][j][k][m] = (float)acc * inv;
					}
				}
	}
	rv = ReadFamDud(&path.noiseP, "/data/", month - 1);
	if (rv != RTN_READFAMDUDOK) return -rv;
	path.month = month - 1;
	month_loaded = month;
	return 0;
}

/*
 * Station / circuit parameters.
 *   ssn       12-month smoothed sunspot number (1..311)
 *   txpow_w   transmitter power (W)
 *   bw        bandwidth (Hz)
 *   snrr      required SNR (dB in bw)
 *   noise     man-made noise: 0 city, 1 residential, 2 rural, 3 quiet rural
 *   year
 */
EXPORT(ohp_set_params) void ohp_set_params(int ssn, double txpow_w, double bw, double snrr, int noise, int year) {
	if (ssn < 1) ssn = 1;
	if (ssn > 311) ssn = 311;
	path.SSN = ssn;
	if (txpow_w < 0.001) txpow_w = 0.001;
	path.txpower = 10.0 * log10(txpow_w / 1000.0);
	if (path.txpower < -30.0) path.txpower = -30.0;
	path.BW = bw;
	path.SNRr = snrr;
	path.noiseP.ManMadeNoise = (double)noise;
	path.year = year;
}

/* Frequencies (MHz) for which antenna patterns are built (usually the bands). */
EXPORT(ohp_set_ant_freq) void ohp_set_ant_freq(int idx, double f) {
	if (idx < 0 || idx >= MAXAFREQ) return;
	ant_freqs[idx] = f;
	if (idx + 1 > ant_nfreq) ant_nfreq = idx + 1;
}

/* which: 0 = TX, 1 = RX. heading < 0 => antenna always points at the other end. */
EXPORT(ohp_set_antenna) void ohp_set_antenna(int which, int type, double height, double heading, double extra, int nfreq) {
	struct AntSpec *a = &ant_spec[which ? 1 : 0];
	a->type = type;
	a->height = height;
	a->heading = heading;
	a->extra = extra;
	ant_dirty = 1;
	if (nfreq > 0 && nfreq <= MAXAFREQ) ant_nfreq = nfreq;
}

EXPORT(ohp_antennas_changed) void ohp_antennas_changed(void) { ant_dirty = 1; }

static void prepare_antennas(void) {
	int f, k;
	struct Antenna *A[2] = { &path.A_tx, &path.A_rx };
	if (!ant_dirty) return;
	for (f = 0; f < 2; f++) {
		const struct AntSpec *s = &ant_spec[f];
		if (s->type == ANT_ISO) {
			A[f]->freqn = 1;
			A[f]->freqs[0] = 0.0;
		} else {
			A[f]->freqn = ant_nfreq;
			for (k = 0; k < ant_nfreq; k++) A[f]->freqs[k] = ant_freqs[k];
		}
		fill_antenna(A[f], s);
	}
	ant_dirty = 0;
}

/*
 * Run P.533 for one path, one UTC hour (0..23), one frequency.
 * Coordinates in degrees. Returns P533 status (10 = OK) and fills result[]:
 *  0 BMUF   1 MUF50  2 MUF90  3 MUF10  4 OPMUF  5 OPMUF90  6 OPMUF10
 *  7 Pr(dBW) 8 SNR(dB) 9 BCR(%) 10 distance(km) 11 field strength Ep (dBuV/m)
 * 12 lowest F2 hops 13 lowest E hops 14 DuSN 15 DlSN 16 elevation of best mode (deg)
 * 17 SNRXX (SNR exceeded 90% of days)
 */
EXPORT(ohp_run) int ohp_run(double txlat, double txlng, double rxlat, double rxlng, int utc_hour, double fmhz) {
	int rv, i;
	double best, ele;
	if (month_loaded < 0) return -1;

	path.L_tx.lat = txlat * D2R;
	path.L_tx.lng = txlng * D2R;
	path.L_rx.lat = rxlat * D2R;
	path.L_rx.lng = rxlng * D2R;
	/* P.533 hour index h means the hour ending at h+1 UTC. */
	path.hour = (utc_hour + 23) % 24;
	path.frequency = fmhz;

	prepare_antennas();

	rv = P533(&path);
	result[0] = path.BMUF;
	result[1] = path.MUF50;
	result[2] = path.MUF90;
	result[3] = path.MUF10;
	result[4] = path.OPMUF;
	result[5] = path.OPMUF90;
	result[6] = path.OPMUF10;
	result[7] = path.Pr;
	result[8] = path.SNR;
	result[9] = path.BCR;
	result[10] = path.distance;
	result[11] = path.Ep;
	result[12] = path.n0_F2 + 1;
	result[13] = path.n0_E + 1;
	result[14] = path.DuSN;
	result[15] = path.DlSN;
	/* Elevation of the strongest short-path mode, if any. */
	best = -1e9; ele = path.ele * R2D;
	for (i = 0; i < MAXF2MDS; i++) {
		if (path.Md_F2[i].BMUF != 0.0 && path.Md_F2[i].Prw > best) { best = path.Md_F2[i].Prw; ele = path.Md_F2[i].ele * R2D; }
	}
	for (i = 0; i < MAXEMDS; i++) {
		if (path.Md_E[i].BMUF != 0.0 && path.Md_E[i].Prw > best) { best = path.Md_E[i].Prw; ele = path.Md_E[i].ele * R2D; }
	}
	result[16] = ele;
	result[17] = path.SNRXX;
	return rv;
}

/* Gain (dBi) of the configured TX (0) or RX (1) antenna, for display/tests. */
EXPORT(ohp_ant_gain) double ohp_ant_gain(int which, double el_deg, double rel_az_deg, double fmhz) {
	return ant_gain(&ant_spec[which ? 1 : 0], el_deg * D2R, rel_az_deg * D2R, fmhz);
}
