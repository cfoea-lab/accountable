// seed-exercises.js — exercise library. Format: [name, muscle, equipment]
// muscle: chest|back|shoulders|biceps|triceps|forearms|quads|hamstrings|glutes|calves|core|cardio|full body
'use strict';
module.exports = [
// Chest
['Bench Press', 'chest', 'barbell'], ['Incline Bench Press', 'chest', 'barbell'], ['Decline Bench Press', 'chest', 'barbell'],
['Dumbbell Bench Press', 'chest', 'dumbbell'], ['Incline Dumbbell Press', 'chest', 'dumbbell'], ['Decline Dumbbell Press', 'chest', 'dumbbell'],
['Dumbbell Fly', 'chest', 'dumbbell'], ['Incline Dumbbell Fly', 'chest', 'dumbbell'], ['Cable Fly', 'chest', 'cable'],
['Low Cable Fly', 'chest', 'cable'], ['Pec Deck', 'chest', 'machine'], ['Chest Press Machine', 'chest', 'machine'],
['Push-Up', 'chest', 'bodyweight'], ['Wide Push-Up', 'chest', 'bodyweight'], ['Incline Push-Up', 'chest', 'bodyweight'],
['Decline Push-Up', 'chest', 'bodyweight'], ['Dip (Chest)', 'chest', 'bodyweight'], ['Smith Machine Bench Press', 'chest', 'machine'],
['Svend Press', 'chest', 'plate'], ['Landmine Press', 'chest', 'barbell'],
// Back
['Deadlift', 'back', 'barbell'], ['Sumo Deadlift', 'back', 'barbell'], ['Rack Pull', 'back', 'barbell'],
['Pull-Up', 'back', 'bodyweight'], ['Chin-Up', 'back', 'bodyweight'], ['Neutral-Grip Pull-Up', 'back', 'bodyweight'],
['Assisted Pull-Up', 'back', 'machine'], ['Lat Pulldown', 'back', 'cable'], ['Close-Grip Lat Pulldown', 'back', 'cable'],
['Straight-Arm Pulldown', 'back', 'cable'], ['Barbell Row', 'back', 'barbell'], ['Pendlay Row', 'back', 'barbell'],
['Dumbbell Row', 'back', 'dumbbell'], ['Chest-Supported Row', 'back', 'dumbbell'], ['Seated Cable Row', 'back', 'cable'],
['T-Bar Row', 'back', 'barbell'], ['Machine Row', 'back', 'machine'], ['Inverted Row', 'back', 'bodyweight'],
['Meadows Row', 'back', 'barbell'], ['Good Morning', 'back', 'barbell'], ['Back Extension', 'back', 'bodyweight'],
['Superman Hold', 'back', 'bodyweight'], ['Shrug (Barbell)', 'back', 'barbell'], ['Shrug (Dumbbell)', 'back', 'dumbbell'],
// Shoulders
['Overhead Press', 'shoulders', 'barbell'], ['Seated Dumbbell Shoulder Press', 'shoulders', 'dumbbell'],
['Arnold Press', 'shoulders', 'dumbbell'], ['Machine Shoulder Press', 'shoulders', 'machine'],
['Push Press', 'shoulders', 'barbell'], ['Lateral Raise', 'shoulders', 'dumbbell'], ['Cable Lateral Raise', 'shoulders', 'cable'],
['Machine Lateral Raise', 'shoulders', 'machine'], ['Front Raise', 'shoulders', 'dumbbell'],
['Rear Delt Fly', 'shoulders', 'dumbbell'], ['Reverse Pec Deck', 'shoulders', 'machine'], ['Face Pull', 'shoulders', 'cable'],
['Upright Row', 'shoulders', 'barbell'], ['Cable Y-Raise', 'shoulders', 'cable'], ['Pike Push-Up', 'shoulders', 'bodyweight'],
['Handstand Push-Up', 'shoulders', 'bodyweight'],
// Biceps
['Barbell Curl', 'biceps', 'barbell'], ['EZ-Bar Curl', 'biceps', 'barbell'], ['Dumbbell Curl', 'biceps', 'dumbbell'],
['Alternating Dumbbell Curl', 'biceps', 'dumbbell'], ['Hammer Curl', 'biceps', 'dumbbell'], ['Incline Dumbbell Curl', 'biceps', 'dumbbell'],
['Concentration Curl', 'biceps', 'dumbbell'], ['Preacher Curl', 'biceps', 'barbell'], ['Cable Curl', 'biceps', 'cable'],
['Rope Hammer Curl', 'biceps', 'cable'], ['Spider Curl', 'biceps', 'dumbbell'], ['Machine Curl', 'biceps', 'machine'],
['Drag Curl', 'biceps', 'barbell'], ['21s (Bicep Curl)', 'biceps', 'barbell'],
// Triceps
['Close-Grip Bench Press', 'triceps', 'barbell'], ['Dip (Triceps)', 'triceps', 'bodyweight'], ['Bench Dip', 'triceps', 'bodyweight'],
['Skullcrusher', 'triceps', 'barbell'], ['Overhead Triceps Extension', 'triceps', 'dumbbell'],
['Cable Overhead Extension', 'triceps', 'cable'], ['Tricep Pushdown', 'triceps', 'cable'], ['Rope Pushdown', 'triceps', 'cable'],
['Single-Arm Pushdown', 'triceps', 'cable'], ['Diamond Push-Up', 'triceps', 'bodyweight'], ['Kickback', 'triceps', 'dumbbell'],
['JM Press', 'triceps', 'barbell'], ['Machine Triceps Extension', 'triceps', 'machine'],
// Forearms
['Wrist Curl', 'forearms', 'barbell'], ['Reverse Wrist Curl', 'forearms', 'barbell'], ['Reverse Curl', 'forearms', 'barbell'],
['Farmer\'s Carry', 'forearms', 'dumbbell'], ['Dead Hang', 'forearms', 'bodyweight'], ['Plate Pinch', 'forearms', 'plate'],
// Quads
['Squat', 'quads', 'barbell'], ['Front Squat', 'quads', 'barbell'], ['Box Squat', 'quads', 'barbell'],
['Goblet Squat', 'quads', 'dumbbell'], ['Smith Machine Squat', 'quads', 'machine'], ['Hack Squat', 'quads', 'machine'],
['Leg Press', 'quads', 'machine'], ['Leg Extension', 'quads', 'machine'], ['Bulgarian Split Squat', 'quads', 'dumbbell'],
['Walking Lunge', 'quads', 'dumbbell'], ['Reverse Lunge', 'quads', 'dumbbell'], ['Step-Up', 'quads', 'dumbbell'],
['Pistol Squat', 'quads', 'bodyweight'], ['Air Squat', 'quads', 'bodyweight'], ['Wall Sit', 'quads', 'bodyweight'],
['Sissy Squat', 'quads', 'bodyweight'], ['Pause Squat', 'quads', 'barbell'],
// Hamstrings
['Romanian Deadlift', 'hamstrings', 'barbell'], ['Dumbbell Romanian Deadlift', 'hamstrings', 'dumbbell'],
['Stiff-Leg Deadlift', 'hamstrings', 'barbell'], ['Lying Leg Curl', 'hamstrings', 'machine'],
['Seated Leg Curl', 'hamstrings', 'machine'], ['Nordic Curl', 'hamstrings', 'bodyweight'],
['Glute-Ham Raise', 'hamstrings', 'bodyweight'], ['Single-Leg RDL', 'hamstrings', 'dumbbell'],
// Glutes
['Hip Thrust', 'glutes', 'barbell'], ['Glute Bridge', 'glutes', 'bodyweight'], ['Machine Hip Thrust', 'glutes', 'machine'],
['Cable Kickback', 'glutes', 'cable'], ['Hip Abduction Machine', 'glutes', 'machine'], ['Sumo Squat', 'glutes', 'dumbbell'],
['Curtsy Lunge', 'glutes', 'dumbbell'], ['Frog Pump', 'glutes', 'bodyweight'], ['Banded Lateral Walk', 'glutes', 'band'],
// Calves
['Standing Calf Raise', 'calves', 'machine'], ['Seated Calf Raise', 'calves', 'machine'],
['Calf Raise (Bodyweight)', 'calves', 'bodyweight'], ['Single-Leg Calf Raise', 'calves', 'bodyweight'],
['Leg Press Calf Raise', 'calves', 'machine'], ['Smith Machine Calf Raise', 'calves', 'machine'],
// Core
['Plank', 'core', 'bodyweight'], ['Side Plank', 'core', 'bodyweight'], ['Crunch', 'core', 'bodyweight'],
['Bicycle Crunch', 'core', 'bodyweight'], ['Sit-Up', 'core', 'bodyweight'], ['Hanging Leg Raise', 'core', 'bodyweight'],
['Hanging Knee Raise', 'core', 'bodyweight'], ['Lying Leg Raise', 'core', 'bodyweight'], ['Russian Twist', 'core', 'bodyweight'],
['Cable Crunch', 'core', 'cable'], ['Cable Woodchopper', 'core', 'cable'], ['Ab Wheel Rollout', 'core', 'wheel'],
['Dead Bug', 'core', 'bodyweight'], ['Bird Dog', 'core', 'bodyweight'], ['Mountain Climber', 'core', 'bodyweight'],
['V-Up', 'core', 'bodyweight'], ['Toes to Bar', 'core', 'bodyweight'], ['Dragon Flag', 'core', 'bodyweight'],
['Pallof Press', 'core', 'cable'], ['Machine Crunch', 'core', 'machine'], ['Decline Sit-Up', 'core', 'bodyweight'],
// Cardio & conditioning (log duration in reps field as minutes, weight 0)
['Running', 'cardio', 'none'], ['Treadmill Run', 'cardio', 'machine'], ['Incline Treadmill Walk', 'cardio', 'machine'],
['Walking', 'cardio', 'none'], ['Cycling', 'cardio', 'machine'], ['Spin Bike', 'cardio', 'machine'],
['Rowing Machine', 'cardio', 'machine'], ['Elliptical', 'cardio', 'machine'], ['Stair Climber', 'cardio', 'machine'],
['Swimming', 'cardio', 'none'], ['Jump Rope', 'cardio', 'rope'], ['Assault Bike', 'cardio', 'machine'],
['Ski Erg', 'cardio', 'machine'], ['Hiking', 'cardio', 'none'], ['Basketball', 'cardio', 'none'],
['Boxing', 'cardio', 'none'], ['HIIT Circuit', 'cardio', 'none'], ['Sprints', 'cardio', 'none'],
// Full body / olympic
['Clean and Jerk', 'full body', 'barbell'], ['Power Clean', 'full body', 'barbell'], ['Snatch', 'full body', 'barbell'],
['Kettlebell Swing', 'full body', 'kettlebell'], ['Kettlebell Clean and Press', 'full body', 'kettlebell'],
['Thruster', 'full body', 'barbell'], ['Burpee', 'full body', 'bodyweight'], ['Man Maker', 'full body', 'dumbbell'],
['Sled Push', 'full body', 'sled'], ['Sled Pull', 'full body', 'sled'], ['Battle Ropes', 'full body', 'rope'],
['Turkish Get-Up', 'full body', 'kettlebell'], ['Sandbag Carry', 'full body', 'sandbag'], ['Tire Flip', 'full body', 'tire'],
];
