import { planIntents } from '../../src/llm/questions.js';

/** A set that follows the plan for `count` questions, each a distinct sentence. */
export function generatedSet(count, { hasCity = false, brand = 'Acme Dental' } = {}) {
  const plan = planIntents(count, { hasCity });
  const questions = [];
  // Real model output varies its wording; a fixture built from one frame would be (correctly) dropped as repeats.
  const topics = [
    'orthodontics for teenagers',
    'emergency tooth pain',
    'professional teeth whitening',
    'titanium dental implants',
    'a toddler’s first checkup',
    'gum disease treatment',
    'wisdom tooth removal',
    'severe dental anxiety',
    'late evening appointments',
    'insurance coverage questions',
    'root canal recovery',
    'cosmetic bonding on chipped teeth',
    'dentures for elderly parents',
    'clear aligners for adults',
    'sleep apnea mouth guards',
    'porcelain crowns',
    'fluoride treatment for kids',
    'sensitive teeth with cold drinks',
    'bad breath that will not go away',
    'veneers before a wedding',
    'dental care while pregnant',
    'a cracked molar',
    'mouth sores that linger',
    'sports mouthguards',
    'payment plans for big work',
    'bridges after losing a tooth',
    'checkups for a whole household',
    'braces cost for two siblings',
    'a second opinion on a quote',
    'grinding teeth at night',
    'tongue tie in newborns',
    'dry mouth from medication',
    'a lost filling on holiday',
    'special needs patients',
    'same day crowns',
    'jaw pain when chewing',
    'stained teeth from coffee',
    'oral cancer screening',
    'retainers that no longer fit',
    'a dentist who speaks Spanish',
    'x-rays and radiation worries',
    'gentle cleanings',
    'dental sealants',
    'receding gums',
    'mini implants',
    'baby teeth that will not fall out',
    'overbite correction',
    'whitening strips versus trays',
    'tooth extractions under sedation',
    'preventive care for diabetics',
  ];
  const wording = {
    discovery: (t) => `Which practices do locals recommend when looking into ${t}?`,
    comparison: (t) => `How does ${brand} stack up against Bright Smiles on ${t}?`,
    problem_solution: (t) => `What is the smartest way to deal with ${t} without wasting money?`,
    brand: (t) => `Would you trust ${brand} for ${t}, and what do patients say?`,
    local: (t) => `Where in Austin can I get quick help with ${t}?`,
    transactional: (t) => `How do I book a visit about ${t} before the weekend?`,
  };
  let n = 0;
  for (const [intent, howMany] of Object.entries(plan)) {
    for (let i = 0; i < howMany; i += 1) {
      questions.push({ intent, text: wording[intent](topics[n % topics.length]) });
      n += 1;
    }
  }
  return questions;
}
