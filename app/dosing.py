"""Deterministic dose/formulation calculators. Used by the calculator panel and as tools for the AI,
so numbers come from code rather than from the model's mental arithmetic."""

import ast
import math
import operator

# FDA 2005 guidance "Estimating the Maximum Safe Starting Dose..." Table 1: Km = body weight (kg) / BSA (m^2)
KM_FACTORS = {
    "human": 37, "human_child": 25, "mouse": 3, "hamster": 5, "rat": 6, "ferret": 7, "guinea_pig": 8,
    "rabbit": 12, "dog": 20, "monkey": 12, "rhesus": 12, "marmoset": 6, "squirrel_monkey": 7, "baboon": 20,
    "micropig": 27, "minipig": 35,
}

_OPS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv,
        ast.Pow: operator.pow, ast.Mod: operator.mod, ast.USub: operator.neg, ast.UAdd: operator.pos,
        ast.FloorDiv: operator.floordiv}
_FUNCS = {"sqrt": math.sqrt, "log": math.log, "log10": math.log10, "exp": math.exp, "ln": math.log,
          "round": round, "abs": abs, "min": min, "max": max, "pow": pow}
_CONSTS = {"pi": math.pi, "e": math.e}


def safe_calc(expr: str) -> float:
    """Evaluate an arithmetic expression without exec/eval."""
    def ev(node):
        if isinstance(node, ast.Expression):
            return ev(node.body)
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
            return node.value
        if isinstance(node, ast.BinOp) and type(node.op) in _OPS:
            right = ev(node.right)
            if isinstance(node.op, ast.Pow) and abs(right) > 100:
                raise ValueError("exponent too large")
            return _OPS[type(node.op)](ev(node.left), right)
        if isinstance(node, ast.UnaryOp) and type(node.op) in _OPS:
            return _OPS[type(node.op)](ev(node.operand))
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in _FUNCS:
            return _FUNCS[node.func.id](*[ev(a) for a in node.args])
        if isinstance(node, ast.Name) and node.id in _CONSTS:
            return _CONSTS[node.id]
        raise ValueError(f"unsupported expression element: {ast.dump(node)[:60]}")
    if len(expr) > 300:
        raise ValueError("expression too long")
    return ev(ast.parse(expr.replace("^", "**"), mode="eval"))


def bsa(weight_kg: float, height_cm: float) -> dict:
    return {
        "mosteller_m2": round(math.sqrt(weight_kg * height_cm / 3600), 3),
        "dubois_m2": round(0.007184 * weight_kg ** 0.425 * height_cm ** 0.725, 3),
        "formula_note": "Mosteller: sqrt(W*H/3600). DuBois: 0.007184*W^0.425*H^0.725",
    }


def hed(dose_mg_per_kg: float, from_species: str, to_species: str = "human", body_weight_kg: float | None = None) -> dict:
    """Allometric (BSA / Km) dose translation between species."""
    f, t = from_species.lower().replace(" ", "_"), to_species.lower().replace(" ", "_")
    if f not in KM_FACTORS or t not in KM_FACTORS:
        raise ValueError(f"species must be one of {sorted(KM_FACTORS)}")
    out = dose_mg_per_kg * KM_FACTORS[f] / KM_FACTORS[t]
    res = {
        "input": f"{dose_mg_per_kg} mg/kg in {f}",
        "km_from": KM_FACTORS[f], "km_to": KM_FACTORS[t],
        "equivalent_dose_mg_per_kg": round(out, 4),
        "formula": f"{dose_mg_per_kg} x ({KM_FACTORS[f]} / {KM_FACTORS[t]})",
        "mg_per_m2": round(dose_mg_per_kg * KM_FACTORS[f], 3),
    }
    if body_weight_kg:
        res["total_dose_mg"] = round(out * body_weight_kg, 3)
        res["body_weight_kg"] = body_weight_kg
    if t.startswith("human"):
        res["mrsd_with_10x_safety_factor_mg_per_kg"] = round(out / 10, 4)
        res["caveat"] = ("FDA BSA scaling is for estimating a starting dose from NOAEL in toxicology; it is not a "
                         "therapeutic-dose predictor and ignores PK differences.")
    return res


def weight_dose(dose_mg_per_kg: float, weight_kg: float, doses_per_day: int = 1,
                concentration_mg_per_ml: float | None = None) -> dict:
    total = dose_mg_per_kg * weight_kg
    res = {"dose_per_administration_mg": round(total, 4), "daily_total_mg": round(total * doses_per_day, 4)}
    if concentration_mg_per_ml:
        res["volume_per_administration_ml"] = round(total / concentration_mg_per_ml, 4)
    return res


def molar(mw_g_per_mol: float, mass_mg: float | None = None, volume_ml: float | None = None,
          concentration_mM: float | None = None) -> dict:
    """Solve for whichever of mass / volume / concentration is missing (exactly one)."""
    missing = [k for k, v in (("mass_mg", mass_mg), ("volume_ml", volume_ml), ("concentration_mM", concentration_mM)) if v is None]
    if len(missing) != 1:
        raise ValueError("provide exactly two of mass_mg, volume_ml, concentration_mM")
    # mmol = mg / (g/mol);  mM = mmol / L
    if mass_mg is None:
        mass_mg = concentration_mM * (volume_ml / 1000) * mw_g_per_mol
    elif volume_ml is None:
        volume_ml = mass_mg / mw_g_per_mol / concentration_mM * 1000
    else:
        concentration_mM = (mass_mg / mw_g_per_mol) / (volume_ml / 1000)
    return {"mass_mg": round(mass_mg, 6), "volume_ml": round(volume_ml, 6), "concentration_mM": round(concentration_mM, 6),
            "concentration_uM": round(concentration_mM * 1000, 4),
            "concentration_mg_per_ml": round(mass_mg / volume_ml, 6), "mw_g_per_mol": mw_g_per_mol}


def dilution(c1: float | None = None, v1: float | None = None, c2: float | None = None, v2: float | None = None) -> dict:
    vals = {"c1": c1, "v1": v1, "c2": c2, "v2": v2}
    missing = [k for k, v in vals.items() if v is None]
    if len(missing) != 1:
        raise ValueError("provide exactly three of c1, v1, c2, v2 (same units on each side)")
    m = missing[0]
    if m == "c1":
        vals["c1"] = c2 * v2 / v1
    elif m == "v1":
        vals["v1"] = c2 * v2 / c1
    elif m == "c2":
        vals["c2"] = c1 * v1 / v2
    else:
        vals["v2"] = c1 * v1 / c2
    out = {k: round(v, 6) for k, v in vals.items()}
    out["diluent_to_add"] = round(vals["v2"] - vals["v1"], 6)
    return out


def reconstitution(vial_mg: float, diluent_ml: float, dose_mcg: float, syringe_units_per_ml: float = 100) -> dict:
    conc_mcg_per_ml = vial_mg * 1000 / diluent_ml
    vol_ml = dose_mcg / conc_mcg_per_ml
    return {
        "concentration_mg_per_ml": round(vial_mg / diluent_ml, 5),
        "concentration_mcg_per_ml": round(conc_mcg_per_ml, 3),
        "volume_per_dose_ml": round(vol_ml, 5),
        "syringe_units_per_dose": round(vol_ml * syringe_units_per_ml, 2),
        "doses_per_vial": round(vial_mg * 1000 / dose_mcg, 2),
        "syringe_note": f"Units assume a U-{int(syringe_units_per_ml)} syringe ({int(syringe_units_per_ml)} units = 1 mL).",
    }


CALCULATORS = {
    "calculate": safe_calc, "bsa": bsa, "hed": hed, "weight_dose": weight_dose,
    "molar": molar, "dilution": dilution, "reconstitution": reconstitution,
}
