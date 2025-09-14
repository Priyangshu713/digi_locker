import { createClient } from "@supabase/supabase-js";

// Initialize Supabase client using environment variables.
// Make sure to add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to your .env (browser-safe keys)
// Example:
//   VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
//   VITE_SUPABASE_ANON_KEY=public-anon-key

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabaseServiceKey = import.meta.env.VITE_SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp0cXNhZHpuaHRldGl3bnN4amZiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1Nzc0MDg0MywiZXhwIjoyMDczMzE2ODQzfQ.AL-tkuqWvW2FZMqOtGRlWE00zBHeIreeSsC8ZmXOK5I';

if (!supabaseUrl || !supabaseAnonKey) {
  // eslint-disable-next-line no-console
  console.warn("Supabase environment variables are missing.\nPlease define VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in your .env file.");
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

/**
 * Upload a document to the `documents` storage bucket and return its public URL.
 * The file will be stored under a timestamp-based path to avoid collisions.
 */
export async function uploadDocument(userId: string, file: File, name: string, category: string, isPrivate: boolean = false): Promise<{ publicUrl: string; path: string }> {
  const fileExt = file.name.split(".").pop();
  // Encode name and category in filename: timestamp_category_name.ext
  const safeName = name.replace(/[^a-zA-Z0-9]/g, '_');
  const prefix = isPrivate ? `${userId}/private` : userId;
  const filePath = `${prefix}/${Date.now()}_${category}_${safeName}.${fileExt}`;

  const { error } = await supabase.storage.from("documents").upload(filePath, file, {
    cacheControl: "3600",
    upsert: false,
    contentType: file.type,
  });

  if (error) {
    throw error;
  }

  const { data } = supabase.storage.from("documents").getPublicUrl(filePath);

    return { publicUrl: data.publicUrl, path: filePath };
}

// Fetch user's documents
// Mark file as deleted in database (bypass storage deletion issues)
export async function moveToTrash(userId: string, path: string) {
  console.log('moveToTrash called with path:', path);
  
  const filename = path.includes('/') ? path.split('/').pop()! : path;
  
  try {
    // Insert into deleted_documents table
    const { error } = await supabase
      .from('deleted_documents')
      .insert({
        user_id: userId,
        document_path: path,
        document_name: filename
      });
    
    if (error) {
      console.error('Database deletion tracking failed:', error);
      throw error;
    }
    
    console.log(`Successfully marked as deleted in database: ${filename}`);
  } catch (error) {
    console.error('moveToTrash failed:', error);
    throw error;
  }
}

export async function restoreFromTrash(userId: string, documentId: string) {
  console.log('restoreFromTrash called with documentId:', documentId);
  
  try {
    // Remove from deleted_documents table to restore
    const { error } = await supabase
      .from('deleted_documents')
      .delete()
      .eq('id', documentId)
      .eq('user_id', userId);
    
    if (error) {
      console.error('Database restore failed:', error);
      throw error;
    }
    
    console.log(`Successfully restored document with ID: ${documentId}`);
  } catch (error) {
    console.error('restoreFromTrash failed:', error);
    throw error;
  }
}

export async function listUserTrash(userId: string) {
  // Get deleted documents from database
  const { data: deletedDocs, error } = await supabase
    .from('deleted_documents')
    .select('*')
    .eq('user_id', userId)
    .order('deleted_at', { ascending: false });
  
  if (error) {
    console.error('Error fetching deleted documents:', error);
    throw error;
  }
  
  // For each deleted document, get its storage info if it still exists
  const trashItems = [];
  
  for (const deletedDoc of deletedDocs || []) {
    try {
      // Try to get the file info from storage
      const { data: pub } = supabase.storage
        .from("documents")
        .getPublicUrl(`${userId}/${deletedDoc.document_name}`);
      
      // Parse display name from filename
      const parts = deletedDoc.document_name.split('_');
      let displayName = deletedDoc.document_name;
      
      if (parts.length >= 3) {
        const nameWithExt = parts.slice(2).join('_');
        displayName = nameWithExt.replace(/\.[^.]+$/, '').replace(/_/g, ' ');
      }
      
      trashItems.push({
        id: deletedDoc.id,
        name: displayName,
        path: deletedDoc.document_path,
        publicUrl: pub.publicUrl,
        size: 0, // We don't have size info from database
        deletedAt: deletedDoc.deleted_at
      });
    } catch (error) {
      console.error(`Error processing deleted document ${deletedDoc.document_name}:`, error);
    }
  }
  
  return trashItems;
}

export async function deletePermanent(userId: string, documentId: string) {
  console.log('Attempting to permanently delete document ID:', documentId);
  
  try {
    // Get the document info first
    const { data: deletedDoc, error: fetchError } = await supabase
      .from('deleted_documents')
      .select('*')
      .eq('id', documentId)
      .eq('user_id', userId)
      .single();
    
    if (fetchError) {
      console.error('Error fetching deleted document:', fetchError);
      throw fetchError;
    }
    
    // Remove from database
    const { error: dbError } = await supabase
      .from('deleted_documents')
      .delete()
      .eq('id', documentId)
      .eq('user_id', userId);
    
    if (dbError) {
      console.error('Database permanent delete failed:', dbError);
      throw dbError;
    }
    
    // Try to delete from storage (optional - may fail but that's ok)
    try {
      const filePath = `${userId}/${deletedDoc.document_name}`;
      await supabaseAdmin.storage.from("documents").remove([filePath]);
      console.log('Successfully deleted from storage:', filePath);
    } catch (storageError) {
      console.warn('Storage deletion failed (this is ok):', storageError);
    }
    
    console.log('Successfully permanently deleted document:', documentId);
  } catch (error) {
    console.error('deletePermanent failed:', error);
    throw error;
  }
}

export async function purgeOldTrash(userId: string, days = 30) {
  const threshold = Date.now() - days * 24 * 60 * 60 * 1000;
  const trash = await listUserTrash(userId);
  const toDelete = trash.filter((t) => t.size > 0 && new Date(t.deletedAt).getTime() < threshold).map((t) => t.path);
  if (toDelete.length) {
    await supabase.storage.from("documents").remove(toDelete);
  }
}

// Smart Folders Management
export async function createSmartFolder(userId: string, folderName: string, description: string = '') {
  const { data, error } = await supabase
    .from('smart_folders')
    .insert({
      user_id: userId,
      folder_name: folderName,
      description: description,
      created_at: new Date().toISOString()
    })
    .select()
    .single();
  
  if (error) throw error;
  return data;
}

export async function getUserSmartFolders(userId: string) {
  const { data, error } = await supabase
    .from('smart_folders')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  
  if (error) throw error;
  return data || [];
}

export async function assignDocumentToFolder(userId: string, documentPath: string, folderId: string) {
  const { data, error } = await supabase
    .from('document_folders')
    .upsert({
      user_id: userId,
      document_path: documentPath,
      folder_id: folderId,
      assigned_at: new Date().toISOString()
    }, {
      onConflict: 'user_id,document_path'
    });
  
  if (error) throw error;
  return data;
}

export async function getDocumentFolderAssignments(userId: string) {
  const { data, error } = await supabase
    .from('document_folders')
    .select(`
      document_path,
      folder_id,
      smart_folders!inner(
        id,
        folder_name,
        description
      )
    `)
    .eq('user_id', userId);
  
  if (error) throw error;
  return data || [];
}

export async function findBestFolderForDocument(userId: string, documentName: string, category: string, type: string) {
  const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY;
  
  if (!GEMINI_API_KEY) {
    return null;
  }

  // Get existing folders
  const folders = await getUserSmartFolders(userId);
  if (folders.length === 0) {
    return null;
  }

  const folderNames = folders.map(f => f.folder_name).join(', ');
  
  const prompt = `
Analyze this document and determine which existing folder it belongs to, or if it needs a new folder.

Document Information:
- Name: ${documentName}
- Category: ${category}
- Type: ${type}

Existing Folders: ${folderNames}

Respond with a JSON object:
{
  "action": "assign" | "create_new",
  "folder_name": "existing_folder_name_or_new_folder_name",
  "reasoning": "brief_explanation"
}

If the document clearly belongs to an existing folder, use "assign".
If it doesn't fit any existing folder, use "create_new" with a suggested new folder name.`;

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-exp:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: prompt
          }]
        }]
      })
    });

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      throw new Error('No response from Gemini AI');
    }

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      return {
        action: result.action || 'create_new',
        folderName: result.folder_name || `${category.charAt(0).toUpperCase() + category.slice(1)} Documents`,
        reasoning: result.reasoning || 'No specific reasoning provided'
      };
    }

    throw new Error('Invalid response format from Gemini AI');
  } catch (error) {
    console.warn('Error finding best folder:', error);
    return null;
  }
}

export async function autoAssignDocumentToFolder(userId: string, documentPath: string, documentName: string, category: string, type: string) {
  try {
    const analysis = await findBestFolderForDocument(userId, documentName, category, type);
    
    if (!analysis) {
      return null;
    }

    if (analysis.action === 'assign') {
      // Find existing folder
      const folders = await getUserSmartFolders(userId);
      const targetFolder = folders.find(f => f.folder_name === analysis.folderName);
      
      if (targetFolder) {
        await assignDocumentToFolder(userId, documentPath, targetFolder.id);
        return {
          action: 'assigned',
          folderName: analysis.folderName,
          reasoning: analysis.reasoning
        };
      }
    }
    
    if (analysis.action === 'create_new') {
      // Create new folder and assign document
      const newFolder = await createSmartFolder(userId, analysis.folderName, `Auto-created for ${documentName}`);
      await assignDocumentToFolder(userId, documentPath, newFolder.id);
      
      return {
        action: 'created_and_assigned',
        folderName: analysis.folderName,
        reasoning: analysis.reasoning
      };
    }
    
    return null;
  } catch (error) {
    console.error('Error auto-assigning document to folder:', error);
    return null;
  }
}

export async function listUserDocuments(userId: string): Promise<Array<{ name: string; path: string; publicUrl: string; size: number; category: string }>> {
  console.log('listUserDocuments called for userId:', userId);
  
  // Get regular documents from userId/ directory
  const { data: regularData, error: regularError } = await supabase.storage.from("documents").list(userId, {
    limit: 100,
    sortBy: { column: "created_at", order: "desc" },
  });
  
  if (regularError) {
    console.error('Error listing regular documents:', regularError);
    throw regularError;
  }
  
  // Get private documents from userId/private/ directory
  const { data: privateData, error: privateError } = await supabase.storage.from("documents").list(`${userId}/private`, {
    limit: 100,
    sortBy: { column: "created_at", order: "desc" },
  });
  
  if (privateError && privateError.message !== 'The resource was not found') {
    console.error('Error listing private documents:', privateError);
  }
  
  // Combine both regular and private documents
  const allData = [
    ...(regularData || []).map(obj => ({ ...obj, isPrivate: false })),
    ...(privateData || []).map(obj => ({ ...obj, isPrivate: true }))
  ];
  
  console.log('Raw storage data:', allData?.map(obj => ({ name: obj.name, size: obj.metadata?.size, isPrivate: obj.isPrivate })));
  
  // Get list of deleted documents from database
  const { data: deletedDocs, error: deletedError } = await supabase
    .from('deleted_documents')
    .select('document_path, document_name')
    .eq('user_id', userId);
  
  if (deletedError) {
    console.error('Error fetching deleted documents:', deletedError);
  }
  
  const deletedPaths = new Set(deletedDocs?.map(doc => doc.document_name) || []);
  console.log('Deleted documents from database:', deletedPaths);
  
  return (
    allData?.filter((obj) => {
      const isDeleted = deletedPaths.has(obj.name);
      console.log(`File ${obj.name}: deleted=${isDeleted}, isPrivate=${obj.isPrivate}`);
      return obj.name.includes('.') && 
             (obj.metadata?.size || 0) > 0 && 
             !obj.name.includes('_trash_') &&
             !isDeleted;
    }).map((obj) => {
      // Build correct path based on whether it's private or not
      const fullPath = obj.isPrivate ? `${userId}/private/${obj.name}` : `${userId}/${obj.name}`;
      const { data: pub } = supabase.storage.from("documents").getPublicUrl(fullPath);
      
      console.log('Processing file:', obj.name, 'Full path:', fullPath, 'isPrivate:', obj.isPrivate);
      
      // Parse filename: timestamp_category_name.ext
      const parts = obj.name.split('_');
      let category = 'other';
      let displayName = obj.name;
      
      if (parts.length >= 3) {
        category = parts[1];
        const nameWithExt = parts.slice(2).join('_');
        displayName = nameWithExt.replace(/\.\w+$/, '').replace(/_/g, ' ');
      }
      
      // Override category to 'private' for private documents
      if (obj.isPrivate) {
        category = 'private';
      }
      
      return {
        name: displayName,
        path: obj.name, // Just the filename, not the full path
        publicUrl: pub.publicUrl,
        size: obj.metadata?.size || 0,
        category: category,
      };
    }) || []
  );
}
