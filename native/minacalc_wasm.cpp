// C interface to Etterna's MinaCalc for the WebAssembly build used by src/main/minacalc.js.
// Build with native/build-minacalc.sh.

#include "etterna/MinaCalc/MinaCalc.h"

#include <memory>
#include <vector>

static std::unique_ptr<Calc> calc;

extern "C" {

int
mc_version()
{
	return GetCalcVersion();
}

/**
 * Rates a 4K chart. `notes[i]` is the column bitmask of row i (bit 0 = leftmost column) and
 * `times[i]` its time in seconds at 1.0x; times must be strictly increasing. Writes the 8 skillset
 * values (Overall, Stream, Jumpstream, Handstream, Stamina, JackSpeed, Chordjack, Technical) to
 * `out`. With `ssr` set it rates a score of `goal` (0..1, capped at 0.965 by the calc) instead of
 * the chart's MSD, which always uses a 93% goal.
 */
void
mc_calc(const unsigned* notes,
		const float* times,
		int count,
		float rate,
		float goal,
		int ssr,
		float* out)
{
	if (!calc)
		calc = std::make_unique<Calc>();

	std::vector<NoteInfo> rows(count);
	for (int i = 0; i < count; i++)
		rows[i] = { notes[i], times[i] };

	std::vector<float> values;
	if (ssr) {
		values = MinaSDCalc(rows, rate, goal, 4, calc.get());
	} else if (rows.size() > 1) {
		calc->ssr = false;
		calc->debugmode = false;
		calc->keycount = 4;
		values = calc->CalcMain(rows, rate, 0.93F);
	}
	for (int i = 0; i < NUM_Skillset; i++)
		out[i] = i < static_cast<int>(values.size()) ? values[i] : 0.F;
}
}
