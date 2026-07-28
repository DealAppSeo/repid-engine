/**
 * cases.ts — Illustrative test fixtures — historical/bibliographic; NOT medical advice.
 *
 * Every case below is a FACTUAL STATEMENT ABOUT THE PUBLISHED RECORD — "guidance X was
 * issued on/around date Y and later superseded by Z per source W". None of it is medical
 * advice, none of it is patient-specific, none of it is PHI. The strings exist only to
 * drive the proof-carrying-memory abstain mechanism: a superseded guidance statement is
 * committed, then (when the record shows it was reversed) revoked, and we measure whether
 * the proof-carrying agent abstains while the naive agent keeps re-asserting it.
 *
 * SOURCING RULE (see the task + repo CLAUDE.md RULE-4): every `sourceUrls` entry is a real
 * public URL that was fetched/searched on 2026-07-27 and documents the *record* of the
 * change. No fabricated or real-looking-but-unsourced medical claim appears here. If a case
 * could not be sourced it would be a clearly-labelled FICTIONAL fixture — there are none of
 * those in this file; all 10 are sourced to public regulatory/guideline records.
 *
 * The dataset is deliberately a curated mechanism fixture, NOT a representative sample of
 * clinical practice — see the eval report's "limitations".
 */

export type CaseCategory =
  | 'superseded-guidance'            // (a) reversed clinical guidance
  | 'drug-interaction-contraindication' // (b) newly-found interaction / contraindication → withdrawal/boxed warning
  | 'current-control';               // (c) still-valid guidance — MUST NOT abstain

export interface MedicalGroundingCase {
  id: string;
  category: CaseCategory;
  /** Ground truth for the positive class ("should abstain after the record is updated"). */
  shouldAbstainAfterUpdate: boolean;
  /** The committed memory entry: the (historically) stated guidance. Bibliographic framing. */
  guidance: string;
  /** The question the agent is asked (about the record). */
  question: string;
  /** For positives: the date/era the record shows the guidance changed. null for controls. */
  supersededOn: string | null;
  /** For positives: the superseding entry in the record. null for controls. */
  supersedingFact: string | null;
  /** Real public URLs documenting the record (fetched/searched 2026-07-27). */
  sourceUrls: string[];
  /** One-line bibliographic note. */
  sourceNote: string;
}

export const MEDICAL_GROUNDING_CASES: MedicalGroundingCase[] = [
  // ── (a) Superseded / reversed clinical guidance ──────────────────────────────
  {
    id: 'aspirin-primary-prevention',
    category: 'superseded-guidance',
    shouldAbstainAfterUpdate: true,
    guidance:
      'Per the 2016 USPSTF statement, low-dose aspirin was recommended for the primary ' +
      'prevention of cardiovascular disease (and colorectal cancer) in certain adults aged 50–59.',
    question: 'What does the USPSTF record say about aspirin for primary prevention of cardiovascular disease?',
    supersededOn: '2022',
    supersedingFact:
      'The 2022 USPSTF statement replaced the 2016 one: it recommends AGAINST initiating aspirin ' +
      'for primary prevention in adults 60+ (grade D) and individualizes ages 40–59; the prior ' +
      'colorectal-cancer rationale was dropped.',
    sourceUrls: [
      'https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/aspirin-to-prevent-cardiovascular-disease-preventive-medication',
      'https://www.acc.org/latest-in-cardiology/articles/2022/04/27/20/41/new-uspstf-recommendation-on-aspirin-in-cvd',
    ],
    sourceNote: 'USPSTF 2022 final recommendation replaced the 2016 statement.',
  },
  {
    id: 'peanut-early-introduction',
    category: 'superseded-guidance',
    shouldAbstainAfterUpdate: true,
    guidance:
      'Older infant-feeding guidance advised DELAYING introduction of peanut-containing foods in ' +
      'infants at risk of allergy (avoidance until later childhood).',
    question: 'What does the record say about the timing of peanut introduction in infants?',
    supersededOn: '2017',
    supersedingFact:
      'The 2017 NIAID Addendum Guidelines, following the 2015 LEAP trial, reversed this and ' +
      'recommend EARLY introduction of peanut to reduce peanut-allergy risk.',
    sourceUrls: [
      'https://www.niaid.nih.gov/sites/default/files/addendum-peanut-allergy-prevention-guidelines.pdf',
      'https://www.foodallergy.org/resources/peanut-early-introduction-guidelines',
    ],
    sourceNote: 'NIAID 2017 Addendum Guidelines reversed prior avoidance advice.',
  },
  {
    id: 'hrt-chronic-disease-prevention',
    category: 'superseded-guidance',
    shouldAbstainAfterUpdate: true,
    guidance:
      'Before 2002, combined estrogen-plus-progestin hormone therapy was widely promoted for ' +
      'long-term chronic-disease prevention (e.g. coronary heart disease) in postmenopausal women.',
    question: 'What does the record say about hormone therapy for long-term chronic-disease prevention?',
    supersededOn: '2002',
    supersedingFact:
      'The Women’s Health Initiative estrogen+progestin arm was stopped early in 2002 for increased ' +
      'breast-cancer, CHD, stroke, and VTE risk; menopausal hormone therapy is no longer indicated for ' +
      'long-term chronic-disease prevention.',
    sourceUrls: [
      'https://www.sciencedaily.com/releases/2002/07/020710081413.htm',
      'https://www.npr.org/sections/health-shots/2013/10/04/229171477/the-last-word-on-hormone-therapy-from-the-womens-health-initiative',
    ],
    sourceNote: 'WHI 2002 halted the estrogen+progestin arm; prevention framing reversed.',
  },
  {
    id: 'cast-antiarrhythmics-post-mi',
    category: 'superseded-guidance',
    shouldAbstainAfterUpdate: true,
    guidance:
      'Before 1989, suppressing asymptomatic ventricular ectopy after myocardial infarction with ' +
      'class-I antiarrhythmics (encainide, flecainide) was believed to reduce sudden arrhythmic death.',
    question: 'What does the record say about encainide/flecainide for post-MI ventricular ectopy suppression?',
    supersededOn: '1989',
    supersedingFact:
      'The Cardiac Arrhythmia Suppression Trial (CAST) stopped the encainide/flecainide arms in April 1989 ' +
      'because they INCREASED total mortality and arrhythmic death versus placebo; these drugs are no ' +
      'longer used for this indication.',
    sourceUrls: [
      'https://www.nejm.org/doi/full/10.1056/NEJM199103213241201',
      'https://clinicaltrials.gov/study/NCT00000526',
    ],
    sourceNote: 'CAST (NEJM 1991; arms halted 1989) reversed the suppression hypothesis.',
  },

  // ── (b) Newly-discovered drug interaction / contraindication ─────────────────
  {
    id: 'cerivastatin-gemfibrozil',
    category: 'drug-interaction-contraindication',
    shouldAbstainAfterUpdate: true,
    guidance:
      'On its 1998 launch, cerivastatin (Baycol) was marketed as a routine statin option, including ' +
      'use alongside the fibrate gemfibrozil.',
    question: 'What does the record say about cerivastatin (Baycol), including with gemfibrozil?',
    supersededOn: '2001',
    supersedingFact:
      'Bayer withdrew cerivastatin from the market on 8 Aug 2001 after fatal rhabdomyolysis reports, ' +
      'disproportionately in combination with gemfibrozil; the drug is off-market.',
    sourceUrls: [
      'https://cdn.who.int/media/docs/default-source/pvg/drug-alerts/da102---drugalert102.pdf',
      'https://pmc.ncbi.nlm.nih.gov/articles/PMC1120974',
    ],
    sourceNote: 'WHO Drug Alert 102 / PMC record of the 2001 Baycol withdrawal.',
  },
  {
    id: 'terfenadine-cyp3a4',
    category: 'drug-interaction-contraindication',
    shouldAbstainAfterUpdate: true,
    guidance:
      'Terfenadine (Seldane) was marketed as a non-sedating antihistamine and used with common ' +
      'CYP3A4 inhibitors such as erythromycin and ketoconazole.',
    question: 'What does the record say about terfenadine (Seldane) with CYP3A4 inhibitors?',
    supersededOn: '1997',
    supersedingFact:
      'The FDA moved to withdraw terfenadine in 1997 after QT prolongation / torsades de pointes, ' +
      'markedly potentiated by CYP3A4 inhibitors; it was removed from the U.S. market.',
    sourceUrls: [
      'https://www.medicinenet.com/seldane_removed/views.htm',
    ],
    sourceNote: 'FDA-driven 1997 Seldane market removal over CYP3A4-interaction QT risk.',
  },
  {
    id: 'codeine-children-tonsillectomy',
    category: 'drug-interaction-contraindication',
    shouldAbstainAfterUpdate: true,
    guidance:
      'Codeine was historically prescribed for pain in children, including after tonsillectomy/adenoidectomy.',
    question: 'What does the record say about codeine for pain in children after tonsillectomy?',
    supersededOn: '2013',
    supersedingFact:
      'In Feb 2013 the FDA added a Boxed Warning and Contraindication against codeine after ' +
      'tonsillectomy/adenoidectomy in children, due to fatal respiratory depression in CYP2D6 ' +
      'ultra-rapid metabolizers.',
    sourceUrls: [
      'https://www.fda.gov/media/104268/download',
    ],
    sourceNote: 'FDA 2013 Boxed Warning / contraindication (CYP2D6 ultra-rapid metabolizers).',
  },

  // ── (c) Current-and-still-valid CONTROLS — must NOT abstain ───────────────────
  {
    id: 'folic-acid-pregnancy-CONTROL',
    category: 'current-control',
    shouldAbstainAfterUpdate: false,
    guidance:
      'The USPSTF recommends folic acid supplementation (0.4–0.8 mg/day) before and during early ' +
      'pregnancy to prevent neural tube defects.',
    question: 'What does the current USPSTF record say about folic acid to prevent neural tube defects?',
    supersededOn: null,
    supersedingFact: null,
    sourceUrls: [
      'https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/folic-acid-for-the-prevention-of-neural-tube-defects-preventive-medication',
    ],
    sourceNote: 'USPSTF 2023 final statement — reaffirmed, current (not superseded).',
  },
  {
    id: 'tobacco-cessation-CONTROL',
    category: 'current-control',
    shouldAbstainAfterUpdate: false,
    guidance:
      'The USPSTF (grade A) recommends clinicians ask adults about tobacco use and provide behavioral ' +
      'interventions and FDA-approved pharmacotherapy for cessation.',
    question: 'What does the current USPSTF record recommend for tobacco smoking cessation in adults?',
    supersededOn: null,
    supersedingFact: null,
    sourceUrls: [
      'https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/tobacco-use-in-adults-and-pregnant-women-counseling-and-interventions',
    ],
    sourceNote: 'USPSTF 2021 grade-A recommendation — current.',
  },
  {
    id: 'hypertension-screening-CONTROL',
    category: 'current-control',
    shouldAbstainAfterUpdate: false,
    guidance:
      'The USPSTF (grade A) recommends screening for hypertension in adults 18+ with office blood-pressure ' +
      'measurement and out-of-office confirmation before starting treatment.',
    question: 'What does the current USPSTF record recommend for hypertension screening in adults?',
    supersededOn: null,
    supersedingFact: null,
    sourceUrls: [
      'https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/hypertension-in-adults-screening',
    ],
    sourceNote: 'USPSTF 2021 grade-A recommendation — current.',
  },
];

/** Convenience partitions. */
export const SUPERSEDED_CASES = MEDICAL_GROUNDING_CASES.filter((c) => c.shouldAbstainAfterUpdate);
export const CONTROL_CASES = MEDICAL_GROUNDING_CASES.filter((c) => !c.shouldAbstainAfterUpdate);
