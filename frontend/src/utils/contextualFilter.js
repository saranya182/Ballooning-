export const contextualFilter = (candidates, allTextItems, pageWidth, pageHeight, unitScale = 1) => {
  if (!candidates || candidates.length === 0) return [];
  if (!allTextItems || allTextItems.length === 0) return candidates;

  const validCandidates = [];

  // 1. Group all text items to find tables/grids
  const u = unitScale > 0 ? unitScale : 1;
  const xTols = 15 * u;
  const yTols = 15 * u;

  allTextItems.forEach(item => {
    item.colAlignments = allTextItems.filter(o => Math.abs(o.centerX - item.centerX) < xTols).length;
    item.rowAlignments = allTextItems.filter(o => Math.abs(o.centerY - item.centerY) < yTols).length;
  });

  const tableCells = allTextItems.filter(i => i.colAlignments > 4 && i.rowAlignments > 2);

  // 2. Score each candidate
  candidates.forEach(candidate => {
    let keepScore = 0;
    let rejectScore = 0;

    const text = candidate.text.toUpperCase();
    
    // Engineering association (strong symbols)
    const hasEngineeringSymbol = /(?:Ø|R|M|±|THRU|CHAMFER|HOLE|TYP|DEGREES|°|DP|C\/BORE|C\/SINK)/i.test(text) || candidate.type !== 'Dimension';
    
    if (hasEngineeringSymbol) {
      keepScore += 100;
    }

    // Check if it's inside a structural table/BOM
    const nearbyTableCells = tableCells.filter(cell => 
      Math.hypot(cell.centerX - candidate.centerX, cell.centerY - candidate.centerY) < 150 * u
    );

    // If it's surrounded by table cells (BOM/Title block)
    if (nearbyTableCells.length > 15) {
      rejectScore += 50;
      
      // If it aligns perfectly in the grid
      if (candidate.colDensity > 3 || candidate.rowDensity > 3) {
        rejectScore += 30;
      }
    } else {
      // It's in a sparse drawing view region
      keepScore += 50;
    }

    const nearbyMetadataCells = allTextItems.filter(cell => 
      /^(REV|DATE|SCALE|WEIGHT|SHEET|MATERIAL|DRAWN|CHECKED|TOLERANCE|TITLE|DRAWING NO|PART NO)/i.test(cell.text) &&
      Math.hypot(cell.centerX - candidate.centerX, cell.centerY - candidate.centerY) < 100 * u
    );

    if (nearbyMetadataCells.length > 0) {
      rejectScore += 40;
    }

    // Decide
    if (keepScore >= rejectScore) {
      validCandidates.push(candidate);
    }
  });

  return validCandidates;
};

