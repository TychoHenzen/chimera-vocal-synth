//! Boundary-layer losses of the airway walls: viscous friction (series, per branch) and heat
//! conduction (shunt, per node). Both grow as the square root of frequency (Flanagan, "Speech
//! Analysis, Synthesis and Perception", 3.2), so a single resistance taken at one frequency
//! overdamps the low formants or leaves the high ones ringing as narrow, tall peaks.
//!
//! The network approximates sqrt(f / REF_HZ) with a constant plus three first-order sections,
//! fitted by least squares over 80 Hz - 12 kHz (0.8 % rms, 2.3 % worst relative error). A viscous
//! section is a resistance in parallel with an inductance in the branch; a heat section is a
//! conductance in series with a capacitance from the node to ground. Each keeps one state.
//! The FDTD discretises the sections with the trapezoid rule (corners prewarped); the frequency
//! solver evaluates the same sections in continuous time.

use crate::math::{PI, sqrt, tan};
use crate::physics::{MU, RHO, RHO_C2};

/// the frequency at which `visc_ref` and `heat_ref` give the loss
pub const REF_HZ: f64 = 700.0;
/// frequency-independent share of the viscous loss (Poiseuille-like; heat has none: an
/// isothermal layer conducts nothing at DC, and a constant shunt would leak a closure's pressure)
pub const FLAT: f64 = 0.27887;
pub const CORNER_HZ: [f64; 3] = [202.9, 1219.7, 7801.1];
pub const WEIGHT: [f64; 3] = [0.46254, 1.04687, 3.224];
pub const N_SEC: usize = 3;

/// Viscous resistance per unit of S*l/A^2 (S perimeter, l length) at REF_HZ: sqrt(rho*mu*w/2).
pub fn visc_ref() -> f64 {
    sqrt((RHO * MU * 2.0 * PI * REF_HZ) / 2.0)
}

/// Heat-conduction conductance per unit of S*l at REF_HZ: (gamma-1)/(rho*c^2)*sqrt(lambda*w/(2rho*c_p)), with
/// gamma = 1.4 and lambda/c_p = 2.29e-4 g/(cm*s) (Flanagan's 0.055e-3 cal/(cm*s*degC) over 0.24 cal/(g*degC)).
pub fn heat_ref() -> f64 {
    (0.4 / RHO_C2) * sqrt((2.29e-4 * 2.0 * PI * REF_HZ) / (2.0 * RHO))
}

/// sqrt(f / REF_HZ) as the sections realise it, in continuous time: (re, im) of the factor that
/// multiplies the REF_HZ loss. `flat` adds the constant term (viscous), or not (heat).
pub fn factor(omega: f64, flat: bool) -> (f64, f64) {
    let mut re = if flat { FLAT } else { 0.0 };
    let mut im = 0.0;
    for i in 0..N_SEC {
        // jx / (1 + jx) = (x^2 + jx) / (1 + x^2)
        let x = omega / (2.0 * PI * CORNER_HZ[i]);
        let d = 1.0 + x * x;
        re += (WEIGHT[i] * x * x) / d;
        im += (WEIGHT[i] * x) / d;
    }
    (re, im)
}

/// Trapezoid-rule coefficients of the sections at sample period `t`: the instantaneous gain of
/// each (times the REF_HZ loss) and the state update s' = d*s + e*input.
#[derive(Clone, Copy, Debug, Default)]
pub struct Sections {
    pub gain: [f64; N_SEC],
    pub d: [f64; N_SEC],
    pub e: [f64; N_SEC],
}

impl Sections {
    pub fn new(t: f64) -> Self {
        let mut s = Sections::default();
        for i in 0..N_SEC {
            // the bilinear map puts the corner at tan(w_c*T/2)*2/T: prewarp it back to w_c
            let a = tan(PI * CORNER_HZ[i] * t);
            s.gain[i] = WEIGHT[i] / (1.0 + a);
            s.d[i] = (1.0 - a) / (1.0 + a);
            s.e[i] = (2.0 * a) / (1.0 + a);
        }
        s
    }
}
