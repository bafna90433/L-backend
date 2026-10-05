/* ------------------------------------------------------------------
   The toys and the steps each one goes through, as written down on the
   floor. Run this once to fill the dropdowns; after that the masters page
   is where things get added and changed.

     node scripts/seed-production-masters.js

   Running it again is safe — anything already there is left alone.
   ------------------------------------------------------------------ */

const CATALOGUE = [
  {
    type: 'Friction Toys',
    toys: [
      { name: 'Fighter Jet', processes: ['Gear box wheel joint', 'Body assembly', 'Gumming'] },
      { name: 'Bird', processes: ['Wheel joint', 'Head joint', 'Body assembly'] },
      { name: 'Scorpion', processes: ['Wheel joint', 'Part cutting', 'Body assembly'] },
      {
        name: 'Lobster',
        processes: ['Wheel joint', 'Hand joint', 'Body assembly', 'Eye gumming', 'Eye joint']
      }
    ]
  },
  {
    type: 'Jumping Toys',
    toys: [
      { name: 'Hen', processes: ['Body assembly', 'Leg gumming', 'Head joint'] },
      { name: 'Dinosaur', processes: ['Body assembly', 'Head joint', 'Leg gumming'] },
      { name: 'Goose', processes: ['Body assembly', 'Head joint', 'Leg gumming'] },
      { name: 'Duck', processes: ['Body assembly', 'Head joint', 'Leg gumming'] }
    ]
  },
  {
    type: 'Windup / Key Toys',
    toys: [
      { name: 'Fish', processes: ['Gear box wheel joint', 'Body assembly', 'Part cutting'] },
      { name: 'Lizard', processes: ['Gear box wheel joint', 'Tong joint', 'Body assembly'] },
      {
        name: 'Ladybug',
        processes: ['Full body assembly', 'Wheel joint', 'Wing joint', 'Antennae joint']
      }
    ]
  },
  {
    type: 'Pull Back',
    // Eight models of the same car. Kept apart so each model can be counted
    // on its own; merge them later if the floor only ever counts the total.
    toys: [1, 2, 3, 4, 5, 6, 7, 8].map(n => ({
      name: `Pull Back Car C-${n}`,
      code: `C-${n}`,
      processes: ['Group body assembly', 'Checking']
    }))
  },
  {
    type: 'Hot Wheel',
    toys: [{ name: 'Hot Wheel', processes: ['Assembly', 'Packing', 'Checking'] }]
  },
  {
    type: 'Plane',
    toys: [{ name: 'Jet Plane', processes: ['Assembly', 'Gumming', 'Checking'] }]
  },
  {
    type: 'P-6',
    toys: [{ name: 'P-6', processes: ['Assembly', 'Checking'] }]
  }
];

const idOf = row => String(row?._id || row?.id || '');

async function initializeCatalogue({ ToyType, Toy, ToyProcess }) {
  let addedTypes = 0;
  let addedToys = 0;
  let addedProcesses = 0;

  for (const [typeIndex, group] of CATALOGUE.entries()) {
    let type = (await ToyType.find({})).find(t => t.name === group.type);
    if (!type) {
      type = await ToyType.create({ name: group.type, sortOrder: typeIndex });
      addedTypes++;
    }

    const existingToys = await Toy.find({ typeId: idOf(type) });

    for (const [toyIndex, toySpec] of group.toys.entries()) {
      let toy = existingToys.find(t => t.name === toySpec.name);
      if (!toy) {
        toy = await Toy.create({
          typeId: idOf(type),
          name: toySpec.name,
          code: toySpec.code || '',
          sortOrder: toyIndex
        });
        addedToys++;
      }

      const existingProcesses = await ToyProcess.find({ toyId: idOf(toy) });

      for (const [processIndex, processName] of toySpec.processes.entries()) {
        if (existingProcesses.some(p => p.name === processName)) continue;
        await ToyProcess.create({
          toyId: idOf(toy),
          name: processName,
          sortOrder: processIndex
        });
        addedProcesses++;
      }
    }
  }

  return { addedTypes, addedToys, addedProcesses };
}

// Classification and unclear photo labels remain editable in the masters UI.
// This initializer only adds missing rows; it never reactivates or overwrites.
module.exports = { CATALOGUE, initializeCatalogue };
if (require.main === module) {
  require('dotenv').config();
  const { connectDatabase } = require('../database');
  connectDatabase().then(() => initializeCatalogue(require('../models'))).then(result => {
    console.log(result); process.exit(0);
  }).catch(error => { console.error('Seeding failed:', error.message); process.exit(1); });
}
