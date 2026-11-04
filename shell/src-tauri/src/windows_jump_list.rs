use std::path::Path;
use std::sync::mpsc;
use std::sync::OnceLock;

use windows::core::{Interface, Result, HSTRING};
use windows::Win32::Foundation::PROPERTYKEY;
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::Common::{IObjectArray, IObjectCollection};
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
use windows::Win32::UI::Shell::{
    DestinationList, EnumerableObjectCollection, ICustomDestinationList, IShellLinkW, ShellLink,
};

const PKEY_TITLE: PROPERTYKEY = PROPERTYKEY {
    fmtid: windows::core::GUID::from_u128(0xf29f85e0_4ff9_1068_ab91_08002b27b3d9),
    pid: 2,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct JumpListTask {
    pub(super) title: String,
    pub(super) argument: &'static str,
}

/// Replaces the Windows taskbar Jump List's static Tasks section.
///
/// Explorer reads the last committed list rather than querying the running app,
/// so these entries intentionally remain useful in every runtime state. A
/// single worker owns COM and serializes locale-driven rebuilds.
pub(super) fn install(tasks: Vec<JumpListTask>) {
    static WORKER: OnceLock<mpsc::Sender<Vec<JumpListTask>>> = OnceLock::new();
    let sender = WORKER.get_or_init(|| {
        let (sender, receiver) = mpsc::channel();
        std::thread::Builder::new()
            .name("maximal-jump-list".to_string())
            .spawn(move || worker(receiver))
            .expect("could not start Windows Jump List worker");
        sender
    });
    if sender.send(tasks).is_err() {
        eprintln!("[shell] Windows Jump List worker stopped unexpectedly");
    }
}

fn worker(receiver: mpsc::Receiver<Vec<JumpListTask>>) {
    // This dedicated thread is always a fresh STA. Balance every successful
    // CoInitializeEx, including S_FALSE, with CoUninitialize on thread exit.
    if let Err(error) = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok() } {
        eprintln!("[shell] could not initialize COM for Windows Jump List: {error}");
        return;
    }

    while let Ok(mut tasks) = receiver.recv() {
        // Locale changes can enqueue a replacement while Explorer is processing
        // the prior transaction. Skip directly to the newest requested list.
        while let Ok(newer) = receiver.try_recv() {
            tasks = newer;
        }
        match std::env::current_exe() {
            Ok(executable) => {
                if let Err(error) = commit(&executable, &tasks) {
                    eprintln!("[shell] could not install Windows Jump List: {error}");
                }
            }
            Err(error) => eprintln!("[shell] could not resolve executable for Jump List: {error}"),
        }
    }

    unsafe { CoUninitialize() };
}

fn commit(executable: &Path, tasks: &[JumpListTask]) -> Result<()> {
    unsafe {
        let destination: ICustomDestinationList =
            CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER)?;
        let mut minimum_slots = 0;
        let _: IObjectArray = destination.BeginList(&mut minimum_slots)?;

        let result = (|| {
            let collection: IObjectCollection =
                CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;
            for task in tasks {
                collection.AddObject(&build_link(executable, task)?)?;
            }
            let array: IObjectArray = collection.cast()?;
            destination.AddUserTasks(&array)?;
            destination.CommitList()
        })();

        if result.is_err() {
            let _ = destination.AbortList();
        }
        result
    }
}

unsafe fn build_link(executable: &Path, task: &JumpListTask) -> Result<IShellLinkW> {
    let link: IShellLinkW = unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)? };
    let executable = HSTRING::from(executable.as_os_str());
    let argument = HSTRING::from(task.argument);
    unsafe {
        link.SetPath(&executable)?;
        link.SetArguments(&argument)?;
        link.SetIconLocation(&executable, 0)?;
    }

    let properties: IPropertyStore = link.cast()?;
    let title = PROPVARIANT::from(task.title.as_str());
    unsafe {
        properties.SetValue(&PKEY_TITLE, &title)?;
        properties.Commit()?;
    }
    Ok(link)
}
